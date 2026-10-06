import numpy as np
import pytest
import traitlets
import zarr
import zarr.storage
from inline_snapshot import snapshot

import vizarr


def viewer_state(viewer: vizarr.Viewer) -> str:
    """Serialize viewer internal state to a readable string for snapshot testing."""
    lines = [f"height: {viewer.height}", f"stores: {len(viewer._store_paths)}"]
    if viewer.view_state:
        lines.append(f"view_state: {viewer.view_state}")
    for i, cfg in enumerate(viewer._configs):
        parts = [f"  {k}={v}" for k, v in cfg.items()]
        lines.append(f"image[{i}]:")
        lines.extend(parts)
    return "\n".join(lines)


def test_includes_version():
    assert isinstance(vizarr.__version__, str)


def test_viewer_defaults():
    v = vizarr.Viewer()
    assert viewer_state(v) == snapshot("""\
height: 500px
stores: 0\
""")


def test_add_image_string_source():
    v = vizarr.Viewer()
    v.add_image("https://example.com/data.zarr")
    assert viewer_state(v) == snapshot("""\
height: 500px
stores: 0
image[0]:
  disable_well_links=True
  source=https://example.com/data.zarr\
""")


def test_add_image_numpy_array():
    v = vizarr.Viewer()
    v.add_image(np.zeros((10, 10), dtype=np.uint8), name="test")
    assert viewer_state(v) == snapshot("""\
height: 500px
stores: 1
image[0]:
  name=test
  disable_well_links=True
  source={'id': 0}\
""")


def test_add_image_zarr_array():
    store = zarr.storage.MemoryStore()
    arr = zarr.create_array(store=store, data=np.ones((5, 5)), zarr_format=2)
    v = vizarr.Viewer()
    v.add_image(arr)
    assert viewer_state(v) == snapshot("""\
height: 500px
stores: 1
image[0]:
  disable_well_links=True
  source={'id': 0}\
""")


def test_add_image_can_reenable_well_links():
    v = vizarr.Viewer()
    v.add_image("https://example.com/plate.zarr", disable_well_links=False)
    assert viewer_state(v) == snapshot("""\
height: 500px
stores: 0
image[0]:
  disable_well_links=False
  source=https://example.com/plate.zarr\
""")


def test_add_multiple_images():
    v = vizarr.Viewer()
    v.add_image("https://a.zarr")
    v.add_image("https://b.zarr")
    v.add_image(np.zeros((3, 3)))
    assert viewer_state(v) == snapshot("""\
height: 500px
stores: 1
image[0]:
  disable_well_links=True
  source=https://a.zarr
image[1]:
  disable_well_links=True
  source=https://b.zarr
image[2]:
  disable_well_links=True
  source={'id': 0}\
""")


def sent_messages(v: vizarr.Viewer, monkeypatch: pytest.MonkeyPatch) -> list[object]:
    """Capture custom messages the viewer sends to the front end."""
    messages: list[object] = []
    monkeypatch.setattr(v, "send", lambda content, *_: messages.append(content))
    return messages


def test_go_to_sends_navigate_command(monkeypatch: pytest.MonkeyPatch) -> None:
    v = vizarr.Viewer()
    messages = sent_messages(v, monkeypatch)
    v.go_to("B03")
    v.go_to(x=10.5, y=20, units="physical", zoom=2)
    v.go_to(field=1)
    assert messages == [
        {"type": "navigate", "options": {"well": "B03", "units": "pixel"}},
        {
            "type": "navigate",
            "options": {"x": 10.5, "y": 20, "zoom": 2, "units": "physical"},
        },
        {"type": "navigate", "options": {"field": 1, "units": "pixel"}},
    ]


def test_select_sends_axis_indices(monkeypatch: pytest.MonkeyPatch) -> None:
    v = vizarr.Viewer()
    messages = sent_messages(v, monkeypatch)
    v.select(t=3, z=10)
    assert messages == [{"type": "select", "selection": {"t": 3, "z": 10}}]


def test_viewport_is_read_only_but_synced_from_front_end():
    v = vizarr.Viewer()
    assert v.viewport == {}
    with pytest.raises(traitlets.TraitError):
        v.viewport = {"well": "A01"}
    v.set_state({"viewport": {"well": "A01", "selection": {"z": 2}}})
    assert v.viewport == {"well": "A01", "selection": {"z": 2}}
