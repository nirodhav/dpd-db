"""Hidden panels are sent empty, with their contents separately."""

import re

from exporter.webapp.lazy_panels import split_hidden_panels


def refill(shell: str, panels: dict[str, str]) -> str:
    """Put each panel's contents back, as the browser does when it's opened."""
    for panel_id, contents in panels.items():
        opening = re.search(rf'<div\b[^>]*\bid="{panel_id}"[^>]*>', shell)
        assert opening, panel_id
        assert shell[opening.end() :].startswith("</div>")
        shell = shell[: opening.end()] + contents + shell[opening.end() :]
    return shell


HEADWORD = (
    '<h3 class="dpd" id="dhamma_1">dhamma 1</h3>'
    '<div class="dpd"><a class="dpd-button" data-target="grammar_dhamma_1">grammar</a>'
    '<div id="grammar_dhamma_1" class="dpd content hidden" name="grammar-div">'
    "<table><tr><td>masc</td></tr></table>"
    '<div class="nested"><div id="inner" class="hidden">x</div></div>'
    "</div>"
    '<div id="family_compound_dhamma_1" class="dpd content hidden"><p>c</p></div>'
    '<div id="visible_dhamma_1" class="dpd content"><p>shown</p></div>'
    "</div>"
)


def test_panels_are_emptied_and_come_back_unchanged() -> None:
    shell, panels = split_hidden_panels(HEADWORD)
    assert list(panels) == ["grammar_dhamma_1", "family_compound_dhamma_1"]
    assert "masc" not in shell
    assert "<p>shown</p>" in shell
    assert refill(shell, panels) == HEADWORD


def test_a_hidden_panel_inside_another_stays_with_its_parent() -> None:
    _, panels = split_hidden_panels(HEADWORD)
    assert "inner" not in panels
    assert 'id="inner"' in panels["grammar_dhamma_1"]


def test_html_without_hidden_panels_is_unchanged() -> None:
    html = '<div class="dpd"><p>No results found.</p></div>'
    assert split_hidden_panels(html) == (html, {})


def test_unbalanced_divs_send_everything() -> None:
    html = '<div id="a" class="hidden"><div>never closed</div>'
    assert split_hidden_panels(html) == (html, {})


def test_a_repeated_id_sends_everything() -> None:
    html = '<div id="a" class="hidden">1</div><div id="a" class="hidden">2</div>'
    assert split_hidden_panels(html) == (html, {})
