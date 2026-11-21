"""Resolve local construction position references using the uploaded text."""

import re

from workspace_product_match import descriptions, explicit_title, pipe_key, reference_override, tender_unit, tokens


MEASURE = re.compile(r"(?P<field>höhe|breite|länge|dicke) (?P<value>\d+(?:\.\d+)?) (?P<unit>mm|cm|m)\b")
PIPE_CLASS = re.compile(r"c\d{2,}")
INSTALLATION_WORDING = re.compile(r"\bliefern und (?:einbauen|versetzen|setzen) (?=(?:höhe|breite|länge|dicke) )")


class PositionReferences:
    """Keep the preceding explicit specification in each numbered section."""

    def __init__(self):
        self.previous = {}

    def resolve(self, position):
        code = str(position.get("oz") or "").rstrip(".")
        if not re.fullmatch(r"\d+(?:\.\d+)+", code):
            return position
        section = tuple(map(int, code.split(".")[:-1]))
        ordinal = int(code.rsplit(".", 1)[1])
        name = tokens(position.get("short"))
        unit = tender_unit(position.get("unit"))
        local = reference_override(name)
        previous = self.previous.get(section)
        if local == name:
            self.previous[section] = (ordinal, unit, explicit_title(position, name))
            return position
        if not previous or previous[0] >= ordinal or not unit or unit != previous[1]:
            return position
        inherited = inherit_title(local, previous[2])
        if not inherited:
            return position
        # Keep extra specification text available to veto the inferred title.
        body = descriptions(name, position.get("long"))[0]
        return {**position, "short": " ".join(inherited), "long": " ".join(body) if body != name else ""}


def pipe_stem(name):
    return tuple(group for group in pipe_key(name)
                 if len(group) == 1 and not PIPE_CLASS.fullmatch(group[0]))


def inherit_title(local, base):
    if measure := MEASURE.fullmatch(" ".join(local)):
        text = " ".join(base)
        matching = [m for m in MEASURE.finditer(text) if m["field"] == measure["field"]]
        if len(matching) == 1:
            match = matching[0]
            complete = text[:match.start()] + measure[0] + text[match.end():]
            return tokens(INSTALLATION_WORDING.sub("", complete))
        return ()

    marker = next((i for i, value in enumerate(base) if value in {"mit", "ohne"}), len(base))
    name = base[:marker]
    stem = pipe_stem(local)
    if not stem or stem != pipe_stem(name):
        return ()
    if {t for t in local if PIPE_CLASS.fullmatch(t)} ^ {t for t in name if PIPE_CLASS.fullmatch(t)}:
        # Grades can be fully replaced, but a grade omitted on either side is ambiguous.
        if not all(any(PIPE_CLASS.fullmatch(t) for t in title) for title in (local, name)):
            return ()
    return (*local, *base[marker:])
