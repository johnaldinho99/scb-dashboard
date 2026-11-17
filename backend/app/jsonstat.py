"""Helpers for JSON-stat 2.0, the default response format of SCB's PxWebApi v2.

A JSON-stat dataset stores values in one flat array in row-major order over the
dimensions listed in ``id`` (the last dimension varies fastest). We flatten it
into tidy rows - one dict per cell - which is much easier to transform.
"""

from __future__ import annotations

from itertools import product
from typing import Any

Row = dict[str, Any]


def dimension_codes(ds: dict, dim: str) -> list[str]:
    """Category codes of a dimension, in the dataset's storage order."""
    index = ds["dimension"][dim]["category"]["index"]
    if isinstance(index, dict):
        return sorted(index, key=index.__getitem__)
    return list(index)


def dimension_labels(ds: dict, dim: str) -> dict[str, str]:
    """Mapping code -> human label for a dimension."""
    category = ds["dimension"][dim]["category"]
    labels = category.get("label") or {}
    return {code: labels.get(code, code) for code in dimension_codes(ds, dim)}


def to_rows(ds: dict) -> list[Row]:
    """Flatten a JSON-stat2 dataset into tidy rows ``{dim: code, ..., "value": v}``.

    Missing values (``null`` in the array, or absent in a sparse dict) become ``None``.
    """
    dims: list[str] = ds["id"]
    codes = [dimension_codes(ds, d) for d in dims]
    expected = 1
    for c in codes:
        expected *= len(c)

    values = ds.get("value", [])
    if isinstance(values, dict):  # sparse representation
        get = lambda i: values.get(str(i))  # noqa: E731
    else:
        if len(values) != expected:
            raise ValueError(f"JSON-stat value length {len(values)} != product of sizes {expected}")
        get = values.__getitem__

    return [{**dict(zip(dims, combo)), "value": get(i)} for i, combo in enumerate(product(*codes))]
