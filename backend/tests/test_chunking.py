from pathlib import Path

import pytest

from folio_ai.ingestion.chunking import chunk_document, heading_level
from tests.conftest import build_paper

DOC = "d" * 64


@pytest.mark.parametrize(
    ("text", "current", "expected"),
    [
        ("3 Model Architecture", 0, (1, True)),
        ("3.2 Attention", 1, (2, True)),
        ("3.2.1 Scaled Dot-Product Attention", 2, (3, True)),
        ("A. Proofs", 1, (1, True)),
        ("A.1 Lemma", 1, (2, True)),
        ("IV. EXPERIMENTS", 2, (1, True)),
        ("References", 3, (1, False)),
        ("Abstract", 0, (1, False)),
        ("A Simple Baseline", 1, (2, False)),  # an unnumbered heading starting with "A", not appendix A
        ("Figure labels and run-in titles", 2, (3, False)),
    ],
)
def test_heading_level(text: str, current: int, expected: tuple[int, bool]) -> None:
    assert heading_level(text, current) == expected


def test_sections_chunks_and_provenance(tmp_path: Path) -> None:
    parsed = tmp_path / "paper.json"
    build_paper(str(parsed))
    d = chunk_document(DOC, parsed, "fake-embed-64", 512)

    assert d.title == "Lanterns and Light"
    assert d.page_count == 2
    titles = {s.title: s for s in d.sections}
    calib, method = titles["2.1 Calibration"], titles["2 Method"]
    assert calib.parent_id == method.id and calib.level == 2
    assert titles["3 Results"].parent_id is None
    assert (titles["3 Results"].page_start, titles["3 Results"].page_end) == (2, 2)

    # Chunks never straddle sections and carry their full heading path + ancestor ids.
    by_text = {c.text: c for c in d.chunks}
    cal_chunk = next(c for t, c in by_text.items() if "standard candle" in t)
    assert cal_chunk.heading_path == ["2 Method", "2.1 Calibration"]
    assert cal_chunk.section_ids == [method.id, calib.id]
    assert "Lighthouse" not in cal_chunk.text
    # Embedding text adds the document title and heading path as context.
    assert cal_chunk.embed_text.startswith("Lanterns and Light\n2 Method\n2.1 Calibration\n")

    # Ids are stable and ordered; every chunk has pages and normalised top-left rects.
    assert [c.id for c in d.chunks] == [f"{DOC}:c{i}" for i in range(len(d.chunks))]
    for c in d.chunks:
        assert 1 <= c.page_start <= c.page_end <= 2
        for loc in c.locations:
            r = loc["rect"]
            assert 0 <= r["x"] < 1 and 0 <= r["y"] < 1 and r["w"] > 0 and r["h"] > 0
            assert r["x"] + r["w"] <= 1 and r["y"] + r["h"] <= 1
    # The calibration paragraph was placed 550pt from the top of an 800pt page.
    cal_rect = next(loc["rect"] for loc in cal_chunk.locations if loc["page"] == 1 and abs(loc["rect"]["y"] - 550 / 800) < 1e-3)
    assert abs(cal_rect["h"] - 40 / 800) < 1e-3

    results = next(c for c in d.chunks if "forty percent" in c.text)
    assert results.page_start == results.page_end == 2


def test_chunks_respect_the_token_budget(tmp_path: Path) -> None:
    from docling_core.types.doc import DocItemLabel, DoclingDocument, Size

    doc = DoclingDocument(name="long")
    doc.add_page(page_no=1, size=Size(width=600, height=800))
    doc.add_heading(text="1 Long Section", level=1)
    for i in range(40):
        doc.add_text(label=DocItemLabel.TEXT, text=f"Sentence number {i} talks about lanterns, wicks, paraffin and keepers at length. " * 3)
    path = tmp_path / "long.json"
    doc.save_as_json(path)
    d = chunk_document(DOC, path, "fake-embed-64", 128)
    assert len(d.chunks) > 5
    assert max(c.token_count for c in d.chunks) <= 128


def test_citation_blocks_take_each_items_own_page_and_box(tmp_path: Path) -> None:
    """A section whose paragraphs sit on different pages: each sentence keeps its own paragraph's location."""
    from docling_core.types.doc import BoundingBox, CoordOrigin, DocItemLabel, DoclingDocument, ProvenanceItem, Size

    doc = DoclingDocument(name="two-pages")
    for p in (1, 2):
        doc.add_page(page_no=p, size=Size(width=600, height=800))

    def prov(page: int, top: float, text: str) -> ProvenanceItem:
        return ProvenanceItem(page_no=page, bbox=BoundingBox(l=60, t=800 - top, r=540, b=800 - top - 40, coord_origin=CoordOrigin.BOTTOMLEFT), charspan=(0, len(text)))

    first = "Keepers lit the lamp at dusk every single evening. They trimmed the wick before midnight."
    second = "The lens focused the beam toward the horizon line. Ships could see it from twenty miles away."
    doc.add_heading(text="1 Lighthouses", level=1, prov=prov(1, 100, "1 Lighthouses"))
    doc.add_text(label=DocItemLabel.TEXT, text=first, prov=prov(1, 600, first))
    doc.add_text(label=DocItemLabel.TEXT, text=second, prov=prov(2, 80, second))
    path = tmp_path / "two.json"
    doc.save_as_json(path)

    (chunk,) = chunk_document(DOC, path, "fake-embed-64", 512).chunks
    pages = [[loc["page"] for loc in b["locations"]] for b in chunk.blocks]
    # The 38-character second sentence is under the 40-character minimum, so it joins the one before it.
    assert [b["text"] for b in chunk.blocks] == [
        "Keepers lit the lamp at dusk every single evening. They trimmed the wick before midnight.",
        "The lens focused the beam toward the horizon line.",
        "Ships could see it from twenty miles away.",
    ]
    assert pages == [[1], [2], [2]]
    assert abs(chunk.blocks[0]["locations"][0]["rect"]["y"] - 600 / 800) < 1e-3
    assert abs(chunk.blocks[-1]["locations"][0]["rect"]["y"] - 80 / 800) < 1e-3
