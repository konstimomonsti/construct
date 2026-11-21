"""A tiny synthetic GAEB XML tender and bid for tests. No tender content from Data/."""


def _item(code: str, qty: str | None, unit: str | None, text: str, extra: str = "") -> str:
    return (f'<Item RNoPart="{code}">'
            + (f"<Qty>{qty}</Qty>" if qty is not None else "")
            + (f"<QU>{unit}</QU>" if unit is not None else "")
            + f"{extra}<Description><CompleteText><OutlineText><OutlTxt><TextOutlTxt>"
              f"<p><span>{text}</span></p></TextOutlTxt></OutlTxt></OutlineText></CompleteText></Description>"
              "</Item>")


def tender_xml() -> bytes:
    """Phase 83: item 0010 has no quantity, 0020 and 0030 are the same work twice, 0040 is a Bedarfsposition."""
    items = "".join([
        _item("0010", None, "m2", "Zementestrich CT-C25-F4, d=50 mm"),
        _item("0020", "100.000", "m", "Randdaemmstreifen 10 mm"),
        _item("0030", "100.000", "m", "Randdaemmstreifen 10 mm"),
        _item("0040", "5.000", "St", "Revisionsklappe", "<Provis>WithoutTotal</Provis>"),
    ])
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<GAEB xmlns="http://www.gaeb.de/GAEB_DA_XML/DA83/3.2">
  <GAEBInfo><Version>3.2</Version></GAEBInfo>
  <PrjInfo><NamePrj>Testprojekt</NamePrj><Cur>EUR</Cur></PrjInfo>
  <Award><DP>83</DP><BoQ><BoQInfo><Name>Estricharbeiten</Name></BoQInfo>
    <BoQBody><BoQCtgy RNoPart="01"><LblTx>Estrich</LblTx>
      <BoQBody><Itemlist>{items}</Itemlist></BoQBody></BoQCtgy></BoQBody>
  </BoQ></Award>
</GAEB>""".encode("utf-8")


def bid_xml() -> bytes:
    """Phase 84 with prices on every item, so the risk model can use amounts."""
    def priced(code, qty, unit, text, up):
        return _item(code, qty, unit, text, f"<UP>{up}</UP><IT>{float(qty) * float(up):.2f}</IT>")
    items = "".join([
        priced("0010", "100.000", "m2", "Zementestrich CT-C25-F4, d=50 mm", "20.00"),
        priced("0020", "100.000", "m", "Randdaemmstreifen 10 mm", "3.00"),
        priced("0030", "100.000", "m", "Randdaemmstreifen 10 mm", "3.00"),
    ])
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<GAEB xmlns="http://www.gaeb.de/GAEB_DA_XML/DA84/3.2">
  <GAEBInfo><Version>3.2</Version></GAEBInfo>
  <PrjInfo><NamePrj>Testprojekt</NamePrj><Cur>EUR</Cur></PrjInfo>
  <Award><DP>84</DP><BoQ><BoQInfo><Name>Estricharbeiten</Name></BoQInfo>
    <BoQBody><BoQCtgy RNoPart="01"><LblTx>Estrich</LblTx>
      <BoQBody><Itemlist>{items}</Itemlist></BoQBody></BoQCtgy></BoQBody>
  </BoQ></Award>
</GAEB>""".encode("utf-8")
