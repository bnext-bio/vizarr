"""Vizarr: an anywidget for viewing Zarr-based images."""

import asyncio
import pathlib
from typing import Literal

import anywidget
import msgspec
import numpy as np
import traitlets
import zarr
import zarr.storage
from zarr.abc.store import Store
from zarr.core.buffer import default_buffer_prototype

__all__ = ["Viewer"]

# ---------------------------------------------------------------------------
# Messages
# ---------------------------------------------------------------------------


class StoreOperation(msgspec.Struct):
    """An operation to perform against a store."""

    method: Literal["has", "get"]
    target: tuple[int, str]


class StoreResult(msgspec.Struct):
    """The result of a store operation."""

    success: bool


class Message[T](msgspec.Struct):
    """A message with a correlation id."""

    uuid: str
    payload: T


# ---------------------------------------------------------------------------
# Store helpers
# ---------------------------------------------------------------------------


def _resolve_store(
    obj: zarr.Array | zarr.Group | np.ndarray | Store,
) -> tuple[Store, str]:
    """Extract a store and key prefix from a zarr-compatible object."""
    if isinstance(obj, (zarr.Array, zarr.Group)):
        prefix = obj.path + "/" if obj.path else ""
        return obj.store, prefix

    if isinstance(obj, np.ndarray):
        store = zarr.storage.MemoryStore()
        zarr.create_array(
            store=store,
            data=obj,
            chunks=obj.shape,
            zarr_format=2,
        )
        return store, ""

    if isinstance(obj, Store):
        return obj, ""

    msg = "Cannot normalize store path"
    raise TypeError(msg)


# ---------------------------------------------------------------------------
# Widget
# ---------------------------------------------------------------------------


class Viewer(anywidget.AnyWidget):
    """An anywidget for viewing Zarr-based images.

    Attributes
    ----------
    view_state
        The deck.gl view: ``{"zoom": float, "target": [x, y]}`` in world
        coordinates. Synced both ways; assign to move the view.
    viewport
        Read-only description of what is in view of the first image, updated
        (debounced) as the view, the window size or the axis selection change.
        Observe it with ``viewer.observe(callback, names="viewport")``. Keys:

        - ``kind``: ``"plate"``, ``"well"`` or ``"image"``
        - ``name``: image/plate name
        - ``well``: well under the center of the view (plates), or the
          well being viewed (well sources); ``None`` otherwise
        - ``field``: field under the center of the view (well sources)
        - ``cell``: ``{"name", "row", "column"}`` of the plate/well grid
          cell under the center of the view, or ``None``
        - ``selection``: index of each non-channel, non-spatial axis, e.g.
          ``{"t": 0, "z": 12}``
        - ``sizes``: size of every axis, e.g. ``{"t": 1, "c": 3, "z": 30,
          "y": 2048, "x": 2048}`` (of one well/field for grids)
        - ``position``: center of the view within the image or grid cell,
          ``{"pixel": [x, y], "physical": [x, y] | None}`` in
          base-resolution pixels and in ``unit``; ``None`` when the
          center is not over a well/field
        - ``region``: visible area within the image or grid cell,
          ``{"pixel": [x0, y0, x1, y1], "physical": [...] | None}``
          (not clipped to the image)
        - ``visible_cells``: names of the wells/fields at least partly in view
        - ``pixel_size``: physical ``[x, y]`` size of a base-resolution
          pixel, and ``unit`` (e.g. ``"micrometer"``); ``None`` if the
          metadata has no units
        - ``zoom``, ``target``, ``bounds`` (``[x0, y0, x1, y1]``) and
          ``size`` (canvas ``[width, height]``): the raw deck.gl view
    """

    _esm = pathlib.Path(__file__).parent / "_widget.js"
    _configs = traitlets.List().tag(sync=True)
    view_state = traitlets.Dict().tag(sync=True)
    viewport = traitlets.Dict(read_only=True).tag(sync=True)
    height = traitlets.Unicode("500px").tag(sync=True)

    def __init__(self, **kwargs: object) -> None:
        super().__init__(**kwargs)
        self._store_paths: list[tuple[Store, str]] = []
        self._pending_tasks: set[asyncio.Task[None]] = set()
        self.on_msg(self._handle_custom_message)

    def _handle_custom_message(
        self,
        _widget: object,
        msg: object,
        _buffers: list[object],
    ) -> None:
        task = asyncio.create_task(self._handle_store_request(msg))
        self._pending_tasks.add(task)
        task.add_done_callback(self._pending_tasks.discard)

    async def _handle_store_request(self, msg: object) -> None:
        message = msgspec.convert(msg, type=Message[StoreOperation])
        store_id, path = message.payload.target
        store, key_prefix = self._store_paths[store_id]
        key = key_prefix + path.lstrip("/")

        if message.payload.method == "has":
            success = await store.exists(key)
            reply = Message(message.uuid, StoreResult(success))
            self.send(msgspec.to_builtins(reply))
            return

        if message.payload.method == "get":
            buf = await store.get(key, prototype=default_buffer_prototype())
            if buf is not None:
                reply = Message(message.uuid, StoreResult(success=True))
                self.send(msgspec.to_builtins(reply), [buf.to_bytes()])
            else:
                reply = Message(message.uuid, StoreResult(success=False))
                self.send(msgspec.to_builtins(reply))
            return

    def go_to(  # noqa: PLR0913
        self,
        well: str | None = None,
        *,
        field: str | int | None = None,
        x: float | None = None,
        y: float | None = None,
        zoom: float | None = None,
        units: Literal["pixel", "physical"] = "pixel",
    ) -> None:
        """Move the view of the first image.

        Parameters
        ----------
        well
            Well to move to, e.g. ``"B03"`` (matching ignores case and
            zero-padding, so ``"b3"`` works too). For a plate, without
            ``x``/``y`` the well is fit into the view.
        field
            Field to move to, when viewing a single well.
        x, y
            Position to center on, within the well/field (or the image). If
            no well/field is given, the position is within the one currently
            under the center of the view. Omitted coordinates default to the
            center of a newly chosen well/field, or else stay where they are.
        zoom
            deck.gl zoom level (log2 of screen pixels per world unit). Defaults
            to fitting a newly chosen well/field, else to the current zoom.
        units
            Units of ``x`` and ``y``: base-resolution ``"pixel"``s, or
            ``"physical"`` units from the OME-NGFF metadata (see
            ``viewport["unit"]``).

        Navigation is applied once the viewer is displayed and the image has
        loaded. Invalid wells/fields are reported in the browser console.
        """
        options = {
            "well": well,
            "field": field,
            "x": x,
            "y": y,
            "zoom": zoom,
            "units": units,
        }
        options = {k: v for k, v in options.items() if v is not None}
        self.send({"type": "navigate", "options": options})

    def select(self, **indices: int) -> None:
        """Set the index of non-channel axes, e.g. ``viewer.select(t=3, z=10)``.

        Applies to every image that has the axis; indices are clamped to the
        axis size. Unknown axes are ignored.
        """
        self.send(
            {"type": "select", "selection": {k: int(v) for k, v in indices.items()}}
        )

    def add_image(
        self,
        source: str | zarr.Array | zarr.Group | np.ndarray | Store,
        **config: object,
    ) -> None:
        """Add an image source to the viewer.

        For plate/well grids, the click-to-open-well links are disabled by
        default in the widget. Pass ``disable_well_links=False`` to re-enable
        them.

        A scale bar (from the OME-NGFF axis units and scale) and an info
        overlay (image/plate name, plus the well under the view once zoomed
        in) are shown by default. Pass ``scalebar=False`` or ``overlay=False``
        to hide them, and ``description="..."`` to add text to the overlay.
        """
        # Default to no click-to-open-well links in the widget; the user can
        # opt back in by passing disable_well_links=False.
        config.setdefault("disable_well_links", True)
        if isinstance(source, str):
            config["source"] = source
        else:
            store, key_prefix = _resolve_store(source)
            config["source"] = {"id": len(self._store_paths)}
            self._store_paths.append((store, key_prefix))
        self._configs = [*self._configs, config]
