"""Compare explicit pipe specifications with the published material scope of cited DIN standards."""

import re

from ..registry import rule
from .common import review_fix


# Public DIN Media scope metadata. Each entry covers the indicated edition's material only.
DRAINAGE_PIPE_STANDARDS = {
    "1401-1": ("PVC-U", "2023-11", "https://www.dinmedia.de/en/standard/din-en-1401-1/366215601"),
    "1852-1": ("PP", "2023-07", "https://www.dinmedia.de/en/standard/din-en-1852-1/358909857"),
    "12666-1": ("PE", "2011-11", "https://www.dinmedia.de/en/standard/din-en-12666-1/139590041"),
}
MATERIAL = r"PVC[-\s]?U|PP|(?:PE(?:[-\s]?(?:HD|100(?:[-\s]?RC)?|80))?|HDPE)"
PIPE = r"(?:Abwasser|Kanalgrund|Kanal)?rohr(?:e|en)?"
PIPE_SPEC = (
    rf"(?:(?P<prefix>{MATERIAL})[-\s]*{PIPE}\b|{PIPE}\s+aus\s+(?P<suffix>{MATERIAL})\b)"
    r"(?:[,\s]+(?:DN(?:/(?:OD|ID))?|SN|SDR|PN)\s*\d+(?:[.,]\d+)?\b)*"
)
STANDARD_NUMBER = "|".join(re.escape(number) for number in DRAINAGE_PIPE_STANDARDS)
DIRECT_REFERENCE = re.compile(
    rf"^\s*{PIPE_SPEC}[,\s]+(?:nach|gemäß)\s+DIN\s+EN\s+(?P<number>{STANDARD_NUMBER})"
    r"(?:\s*:\s*(?P<edition>\d{4}-\d{2}))?(?![\w/+:-]|\s*:)",
    re.IGNORECASE,
)
ALTERNATE_REFERENCE = re.compile(r"^[\s,;]*(?:oder\b|bzw\.|/)", re.IGNORECASE)


def _references(snapshot):
    profile = snapshot.project.profile
    for line in snapshot.lines:
        short, detail = line.short_text or "", line.long_text or ""
        seen = set()
        for field, text in (("short_text", short), ("long_text", detail), ("long_text", f"{short}\n{detail}")):
            match = DIRECT_REFERENCE.match(text)
            if not match or ALTERNATE_REFERENCE.match(text[match.end():]):
                continue
            number = match["number"]
            profile_edition = profile.standard_editions.get(f"DIN EN {number}") if profile else None
            key = (number, match["edition"], match["prefix"] or match["suffix"])
            if key in seen:
                continue
            seen.add(key)
            yield line, field, match, profile_edition


def material_family(value):
    if not isinstance(value, str) or not re.fullmatch(MATERIAL, value.strip(), re.I):
        return None
    normalized = re.sub(r"[-\s]+", "", value.upper())
    return {"PVCU": "PVC-U", "PP": "PP"}.get(normalized, "PE")


def supported_pipe_scopes(snapshot):
    references = list(_references(snapshot))
    editions = {}
    for line, _, match, profile_edition in references:
        key = (line.id, match["number"])
        editions.setdefault(key, set()).update(
            edition for edition in (match["edition"], profile_edition) if edition
        )
    for line, field, match, profile_edition in references:
        number = match["number"]
        standard = DRAINAGE_PIPE_STANDARDS[number]
        governing = editions[(line.id, number)]
        if governing - {standard[1]}:
            continue
        basis = "project_profile" if profile_edition else "position" if governing else "public_scope"
        yield line, field, match, standard, basis


@rule("L1.DIN.PIPE_MATERIAL_SCOPE", layer=1, category="standards", severity="warning",
      title="Pipe material conflicts with cited DIN standard",
      description="An explicit drainage pipe material differs from the public scope of its cited product standard.")
def pipe_material_scope(ctx):
    seen = set()
    for line, field, match, (expected, edition, url), basis in supported_pipe_scopes(ctx.input):
        number = match["number"]
        material = material_family(match["prefix"] or match["suffix"])
        key = (line.id, number, material)
        if material == expected or key in seen:
            continue
        seen.add(key)
        identifier = f"DIN EN {number}"
        specification = " ".join(match[0].split())
        yield ctx.finding(
            line=line, field=field, discriminator=f"{number}/{material}",
            message=f"“{specification}” specifies {material}. The published scope of "
                    f"{identifier}:{edition} covers {expected} drainage pipes. Verify the material or reference.",
            suggested_fix=review_fix(f"Confirm the intended design. Specify {expected} if {identifier} governs, or correct the reference to the approved standard for {material}."),
            evidence={
                "specification": specification, "specified_material": material, "scope_material": expected,
                "edition_basis": basis,
                "din_standard": {"identifier": identifier, "edition": edition, "url": url},
            },
        )


@rule("L1.DIN.EDITION_UNCHECKED", layer=1, category="standards", severity="warning",
      title="Cited DIN edition needs verification",
      description="A directly cited edition differs from the edition documented in the rule register.")
def unchecked_edition(ctx):
    seen = set()
    for line, field, match, profile_edition in _references(ctx.input):
        number = match["number"]
        _, checked, _ = DRAINAGE_PIPE_STANDARDS[number]
        editions = {edition for edition in (match["edition"], profile_edition) if edition and edition != checked}
        for edition in sorted(editions):
            key = (line.id, number, edition)
            if key in seen:
                continue
            seen.add(key)
            yield ctx.finding(
                line=line, field=field, discriminator=f"{number}/{edition}",
                message=f"The assessment references DIN EN {number}:{edition}. The material check has scope evidence for edition {checked}.",
                evidence={"outcome": "insufficient_evidence", "standard": f"DIN EN {number}",
                          "cited_edition": match["edition"], "profile_edition": profile_edition, "supported_edition": checked},
                suggested_fix=review_fix(f"Confirm the edition required by the project and supply scope or clause evidence for {edition}."),
            )
