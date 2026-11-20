# Builds packages/sources/src/towns-ie.json (Republic of Ireland town -> county) for countyOf (D1-B gap round, 20 Nov 2026).
# Source: GeoNames, CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/), read 20 Nov 2026:
#   https://download.geonames.org/export/dump/cities500.zip  (places of 500 people or more; country IE is the Republic only)
#   https://download.geonames.org/export/dump/admin2Codes.txt (IE admin2 = the counties and Dublin, Cork, Galway, Limerick council areas)
# Run: python3 -I towns-ie.py <dir with cities500.txt and admin2Codes.txt> > ../src/towns-ie.json
import json, re, sys
d = sys.argv[1]
COUNTIES = "Carlow Cavan Clare Cork Donegal Dublin Galway Kerry Kildare Kilkenny Laois Leitrim Limerick Longford Louth Mayo Meath Monaghan Offaly Roscommon Sligo Tipperary Waterford Westmeath Wexford Wicklow".split()
IRISH = {"Uibh Fhaili": "Offaly", "An Longfort": "Longford", "An Cabhan": "Cavan", "Fingal County": "Dublin", "Dun Laoghaire-Rathdown": "Dublin", "South Dublin": "Dublin"}
# words that are a place in GeoNames but common in location text ("Peamount Hospital" is not Hospital, Co. Limerick)
STOP = {"ireland", "ford", "road", "tower", "hospital"}
county = {}
for line in open(f"{d}/admin2Codes.txt", encoding="utf-8"):
    code, _, ascii_name, _ = line.rstrip("\n").split("\t")
    if code.startswith("IE."):
        county[code.split(".")[2]] = IRISH.get(ascii_name) or next(c for c in COUNTIES if re.search(rf"(?<![a-z]){c}(?![a-z])", ascii_name, re.I))
key = lambda n: " ".join(n.lower().split())
best, ni = {}, set()
alt_ok = re.compile(r"^[A-Za-zÀ-ſ' -]{5,40}$")  # other names: Latin letters, 5 or more (drops "Dub", "Rod" and other short transliterations)
for line in open(f"{d}/cities500.txt", encoding="utf-8"):
    f = line.rstrip("\n").split("\t")
    names, alts = {f[1], f[2]}, set(f[3].split(",")) - {f[1], f[2], ""}
    if f[8] == "GB" and f[10] == "NIR":
        ni.update(key(n) for n in names | alts)
    if f[8] != "IE" or f[11] not in county:
        continue
    pop = int(f[14] or 0)
    for tier, group in ((0, names), (1, {a for a in alts if alt_ok.match(a)})):
        for n in group:
            k, rank = key(n), (tier, -pop)  # a main name beats another name; then the bigger place wins ("Blackrock": Dublin, not Louth)
            if len(k) >= 3 and (k not in best or rank < best[k][0]):
                best[k] = (rank, county[f[11]])
lower = {c.lower() for c in COUNTIES}
# a name also used in Northern Ireland (Newcastle, Dundrum, Crumlin) is left out: it cannot tell the two apart
out = {k: c for k, (_, c) in sorted(best.items()) if k not in ni and k not in lower and k not in STOP}
json.dump(out, sys.stdout, ensure_ascii=False, separators=(",", ":"))
