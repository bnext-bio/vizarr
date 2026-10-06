# vizarr

```sh
pip install vizarr
```

```python
import vizarr
import zarr

viewer = vizarr.Viewer()
viewer.add_image(source=zarr.open("path/to/ome.zarr"))
viewer
```



### syncing with the view

`viewer.viewport` describes what is in view of the first image, and updates as
you pan, zoom or change the T/Z sliders. For plates it includes the well under
the center of the view, plus the center and visible region within that well,
in pixels and physical units:

```python
viewer.viewport
# {'kind': 'plate', 'well': 'B03', 'selection': {'t': 0, 'z': 12},
#  'position': {'pixel': [812.0, 640.5], 'physical': [263.9, 208.2]},
#  'region': {'pixel': [...], 'physical': [...]}, 'unit': 'micrometer',
#  'visible_cells': ['B03', ...], ...}

def on_view_change(change):
    vp = change["new"]
    print(vp["well"], vp["selection"], vp["position"])

viewer.observe(on_view_change, names="viewport")
```

Navigate from Python (e.g. from buttons or a plot's click handler):

```python
viewer.go_to("B03")                                  # fit a well
viewer.go_to("B03", x=250, y=120, units="physical")  # center on a point (µm) in a well
viewer.go_to(x=100, y=100)                           # move within the current well
viewer.go_to(zoom=2)                                 # zoom, keeping the center
viewer.select(t=3, z=10)                             # change timepoint / z-plane
```

### development

```sh
ANYWIDGET_HMR=1 uv run --group examples jupyter lab notebooks/
```

```sh
uv run ruff check # lint
uv run ty check   # typecheck
```
