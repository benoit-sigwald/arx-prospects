# -*- coding: utf-8 -*-
"""Pilote de decouverte de site web, puis d'e-mails, a cout nul.

Aucune API payante, aucune cle. La chaine est :

    raison sociale -> domaines candidats -> le domaine repond-il ?
      -> la page confirme-t-elle la societe ? -> page contact -> e-mails

L'etape de confirmation est le coeur du dispositif : un domaine qui repond ne
prouve rien, il peut appartenir a un homonyme ou a un parking publicitaire. On
n'accepte que si la page cite la societe.

    python pilote_domaines.py pilote200.json resultats.json

La sortie porte, pour chaque societe, le domaine retenu ou la raison du rejet,
afin que le taux annonce soit verifiable ligne a ligne.
"""
import concurrent.futures as cf
import io
import json
import re
import socket
import sys
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from urllib.robotparser import RobotFileParser

DELAI = 6
UA = "Mozilla/5.0 (compatible; arx-enrichissement/1.0; +https://arx-consulting.com)"

# Mots trop generiques pour identifier une societe dans une page.
VIDES = {"SA", "SAS", "SASU", "SARL", "EURL", "SNC", "SCI", "SCA", "GROUPE", "GROUP",
         "COMPAGNIE", "SOCIETE", "STE", "ETS", "ETABLISSEMENTS", "FRANCE", "HOLDING",
         "INTERNATIONAL", "DE", "DU", "DES", "LA", "LE", "LES", "ET", "EXPANSION",
         "PARTICIPATIONS", "INVESTISSEMENT", "INVESTISSEMENTS", "FINANCIERE", "IMMOBILIER"}

# Adresses de service : presentes partout, sans valeur de prise de contact.
JETABLES = re.compile(r"^(no-?reply|postmaster|abuse|webmaster|hostmaster|mailer-daemon)@", re.I)
RE_MAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
RE_LIEN = re.compile(r'href=["\']([^"\']+)["\']', re.I)
MOTS_CONTACT = ("contact", "equipe", "team", "about", "qui-sommes", "nous-connaitre",
                "mentions-legales", "direction")


def sans_accent(s):
    s = unicodedata.normalize("NFKD", s or "")
    return "".join(c for c in s if not unicodedata.combining(c))


def jetons(nom):
    """Mots significatifs d'une raison sociale."""
    s = sans_accent(nom).upper()
    s = re.sub(r"\([^)]*\)", " ", s)
    return [m for m in re.split(r"[^A-Z0-9]+", s) if len(m) >= 3 and m not in VIDES]


def candidats(nom):
    """Domaines plausibles, du plus probable au moins probable."""
    j = jetons(nom)
    if not j:
        return []
    bases = []
    if len(j) == 1:
        bases = [j[0]]
    else:
        bases = [j[0], "".join(j[:2]), "-".join(j[:2]).lower()]
        if len(j[0]) >= 6:
            bases.insert(0, j[0])
    vus, sortie = set(), []
    for b in bases:
        b = b.lower()
        if len(b) < 3 or b in vus:
            continue
        vus.add(b)
        for tld in (".fr", ".com"):
            sortie.append(b + tld)
    return sortie[:6]


def resout(domaine):
    try:
        socket.getaddrinfo(domaine, 443, proto=socket.IPPROTO_TCP)
        return True
    except OSError:
        return False


def lire(url, taille=180000):
    req = urllib.request.Request(url, headers={"User-Agent": UA,
                                               "Accept-Language": "fr,en;q=0.8"})
    with urllib.request.urlopen(req, timeout=DELAI) as r:
        brut = r.read(taille)
        charset = r.headers.get_content_charset() or "utf-8"
        return r.geturl(), brut.decode(charset, "replace")


def autorise(base, chemin):
    """robots.txt fait foi : on ne lit pas ce qu'un site nous refuse."""
    rp = RobotFileParser()
    rp.set_url(urllib.parse.urljoin(base, "/robots.txt"))
    try:
        rp.read()
    except Exception:
        return True          # pas de robots.txt lisible : regle par defaut, on lit
    return rp.can_fetch(UA, urllib.parse.urljoin(base, chemin))


def confirme(page, nom):
    """La page parle-t-elle bien de cette societe ?"""
    t = sans_accent(page).upper()
    j = jetons(nom)
    if not j:
        return False
    # Le premier jeton est le plus distinctif ; on exige au moins deux jetons
    # quand le nom en compte plusieurs, pour eviter les coincidences.
    presents = sum(1 for m in j if m in t)
    return presents >= (2 if len(j) >= 2 else 1)


def emails(page, domaine):
    out = set()
    for m in RE_MAIL.findall(page):
        m = m.strip(".,;:)")
        if JETABLES.match(m):
            continue
        # On ne retient que les adresses du domaine visite : les autres sont
        # celles de l'agence web, du webmaster ou d'un partenaire.
        if m.lower().split("@")[-1].endswith(domaine.split(".", 1)[-1]) or domaine in m.lower():
            out.add(m.lower())
    return sorted(out)


def pages_contact(base, page):
    liens = []
    for h in RE_LIEN.findall(page):
        b = h.lower()
        if any(m in b for m in MOTS_CONTACT) and not b.startswith(("mailto:", "tel:", "#")):
            u = urllib.parse.urljoin(base, h)
            if urllib.parse.urlparse(u).netloc == urllib.parse.urlparse(base).netloc:
                liens.append(u)
    vus, out = set(), []
    for l in liens:
        if l not in vus:
            vus.add(l)
            out.append(l)
    return out[:3]


def traiter(soc):
    nom = soc["RAISON_SOCIALE"]
    fiche = {"siren": soc["SIREN"], "nom": nom, "ville": soc.get("VILLE"),
             "ca": soc.get("CA_EUR"), "dirigeants": soc.get("NB_DIRIGEANTS"),
             "candidats": candidats(nom), "domaine": None, "emails": [],
             "motif": "aucun candidat"}
    if not fiche["candidats"]:
        return fiche

    fiche["motif"] = "aucun domaine ne resout"
    for d in fiche["candidats"]:
        if not resout(d):
            continue
        fiche["motif"] = "domaine repond mais page illisible"
        try:
            url, page = lire("https://" + d)
        except Exception:
            try:
                url, page = lire("http://" + d)
            except Exception:
                continue
        if not confirme(page, nom):
            fiche["motif"] = "domaine repond mais ne cite pas la societe"
            continue

        fiche["domaine"], fiche["motif"] = d, "confirme"
        trouves = set(emails(page, d))
        for lien in pages_contact(url, page):
            chemin = urllib.parse.urlparse(lien).path
            if not autorise(url, chemin):
                continue
            try:
                _, p2 = lire(lien)
            except Exception:
                continue
            trouves |= set(emails(p2, d))
        fiche["emails"] = sorted(trouves)
        fiche["motif"] = "confirme, avec e-mail" if trouves else "confirme, sans e-mail"
        break
    return fiche


def main(entree, sortie):
    socs = json.load(io.open(entree, encoding="utf-8"))
    print("societes a traiter : %d" % len(socs))
    res = []
    with cf.ThreadPoolExecutor(max_workers=16) as ex:
        for i, f in enumerate(cf.as_completed([ex.submit(traiter, s) for s in socs]), 1):
            res.append(f.result())
            if i % 25 == 0:
                print("  ... %d/%d" % (i, len(socs)))

    json.dump(res, io.open(sortie, "w", encoding="utf-8"), ensure_ascii=False, indent=1)

    n = len(res)
    conf = [r for r in res if r["domaine"]]
    avec = [r for r in conf if r["emails"]]
    total_mails = sum(len(r["emails"]) for r in conf)
    print("")
    print("=== PILOTE (n=%d) ===" % n)
    print("  domaine confirme       : %3d  (%5.1f%%)" % (len(conf), 100.0 * len(conf) / n))
    print("  dont avec e-mail       : %3d  (%5.1f%% du total)" % (len(avec), 100.0 * len(avec) / n))
    print("  e-mails recoltes       : %3d" % total_mails)
    print("  motifs de rejet :")
    motifs = {}
    for r in res:
        if not r["domaine"]:
            motifs[r["motif"]] = motifs.get(r["motif"], 0) + 1
    for m, k in sorted(motifs.items(), key=lambda x: -x[1]):
        print("    %-46s %3d" % (m, k))
    print("sortie : %s" % sortie)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
