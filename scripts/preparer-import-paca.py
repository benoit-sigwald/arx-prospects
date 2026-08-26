# -*- coding: utf-8 -*-
"""Prepare l'import PACA a partir du lac JSONL d'investor-sources.

Le lac melange des organisations et des contacts de toutes provenances. On ne
retient que ce qui releve de PACA, et on ramene chaque enregistrement au format
des tables ENTREPRISES et CONTACTS pour que l'insertion cote base reste bete.

    python preparer-import-paca.py <dossier_data> <sortie.ndjson>

La sortie est un NDJSON de deux types de lignes : {"t":"o",...} pour une
organisation, {"t":"c",...} pour un contact, ce dernier portant le SIREN de son
organisation plutot qu'un identifiant interne — la base attribuera les siens.
"""
import io
import json
import os
import re
import sys
import unicodedata
from datetime import date

DEPS_PACA = {"04", "05", "06", "13", "83", "84"}

# Fichiers du lac retenus, avec le libelle porte dans la colonne SOURCE.
FICHIERS = [
    ("FR_PacaPatrimonial.jsonl", "FR/PacaPatrimonial (Recherche d'entreprises, DINUM)"),
    ("FR_RechercheEntreprises.jsonl", "FR/RechercheEntreprises (DINUM)"),
    ("FR_FranceInvest.jsonl", "FR/FranceInvest (annuaire des membres)"),
    ("FR_FranceAngels.jsonl", "FR/FranceAngels (reseaux de business angels)"),
    ("GLOBAL_Gleif.jsonl", "GLOBAL/GLEIF (identifiants LEI)"),
    ("US_SecFormD.jsonl", "US/SEC Form D"),
    ("GLOBAL_OpenBook.jsonl", "GLOBAL/OpenBook"),
]


def sans_accent(s):
    s = unicodedata.normalize("NFKD", s or "")
    return "".join(c for c in s if not unicodedata.combining(c))


def norm(s):
    return re.sub(r"[^A-Z0-9]", "", sans_accent(s).upper())


def coupe(v, n):
    """Tronque a la longueur de la colonne Oracle, sans couper au milieu d'un
    caractere composite."""
    if v is None:
        return None
    s = str(v).strip()
    return s[:n] if s else None


def entier(v):
    try:
        n = int(float(v))
        return n
    except (TypeError, ValueError):
        return None


def departement(r):
    cp = str(r.get("postal_code") or "")
    return cp[:2] if len(cp) >= 2 and cp[:2].isdigit() else None


def naf(r):
    m = re.search(r"NAF\s+([0-9]{2}\.?[0-9]{0,2}[A-Z]?)", str(r.get("notes") or ""))
    return m.group(1) if m else None


def annee(r):
    return entier(r.get("revenue_year")) or entier(r.get("headcount_year"))


def org_vers_entreprise(r, libelle_source):
    dep = departement(r)
    siren = coupe(r.get("registration_id"), 9)
    nom = coupe(r.get("org_name"), 300)
    if not nom:
        return None
    # L'effectif du registre est une tranche. On retient la borne basse : un
    # filtre « 50 salaries et plus » ne doit pas ramener une societe de 20.
    bas = entier(r.get("headcount_min"))
    return {
        "t": "o",
        "siren": siren if siren and siren.isdigit() else None,
        "nom": nom,
        "nom_norm": coupe(norm(nom), 300),
        "territoire": "06" if dep == "06" else "PACA",
        "departement": dep,
        "naf": coupe(naf(r), 10),
        "adresse": coupe(r.get("address"), 300),
        "cp": coupe(r.get("postal_code"), 10),
        "ville": coupe(r.get("city"), 120),
        "site": coupe(r.get("website"), 300),
        "tel": coupe(r.get("phone") or r.get("telephone"), 60),
        "effectif": bas,
        "effectif_estime": coupe(r.get("headcount_range"), 20),
        "ca": entier(r.get("revenue_eur")),
        "resultat": entier(r.get("net_income_eur")),
        "annee": annee(r),
        "source": coupe(libelle_source, 250),
        "source_url": coupe(r.get("source_url"), 400),
        "secteur": coupe(r.get("org_type"), 200),
        "notes": coupe(r.get("notes"), 900),
    }


def contact_vers_contact(r, siren, libelle_source):
    nom = coupe(r.get("last_name") or r.get("full_name"), 200)
    if not nom:
        return None
    return {
        "t": "c",
        "siren": siren,
        "prenom": coupe(r.get("first_name"), 120),
        "nom": nom,
        "fonction": coupe(r.get("job_title"), 200),
        "intitule": coupe(r.get("job_title"), 300),
        "lieu": coupe(r.get("city"), 200),
        "email": coupe(r.get("email"), 320),
        "tel": coupe(r.get("phone") or r.get("telephone"), 60),
        "linkedin": coupe(r.get("linkedin_url"), 400),
        "source": coupe(libelle_source, 250),
        "annee": annee(r),
        "base_legale": coupe(r.get("legal_basis"), 60),
        "liste": "PacaPatrimonial" if "Paca" in libelle_source else coupe(libelle_source, 120),
    }


def main(dossier, sortie):
    orgs, contacts = [], []
    vus_siren = set()
    stats = {}

    for fichier, libelle in FICHIERS:
        chemin = os.path.join(dossier, fichier)
        if not os.path.exists(chemin):
            print("  absent : %s" % fichier)
            continue

        # Premiere passe : les organisations PACA, indexees par leur _id de lac
        # pour rattacher ensuite leurs contacts.
        par_id, n_org = {}, 0
        with io.open(chemin, encoding="utf-8") as f:
            for ligne in f:
                if not ligne.strip():
                    continue
                r = json.loads(ligne)
                if r.get("_type") != "organization":
                    continue
                if departement(r) not in DEPS_PACA:
                    continue
                e = org_vers_entreprise(r, libelle)
                if not e:
                    continue
                # Le lac contient des doublons entre sources : le SIREN tranche.
                if e["siren"]:
                    if e["siren"] in vus_siren:
                        par_id[r.get("_id")] = e["siren"]
                        continue
                    vus_siren.add(e["siren"])
                par_id[r.get("_id")] = e["siren"]
                orgs.append(e)
                n_org += 1

        # Seconde passe : les contacts rattaches a une de ces organisations.
        n_ct = 0
        with io.open(chemin, encoding="utf-8") as f:
            for ligne in f:
                if not ligne.strip():
                    continue
                r = json.loads(ligne)
                if r.get("_type") != "contact":
                    continue
                oid = r.get("org_id")
                if oid not in par_id:
                    continue
                siren = par_id[oid]
                if not siren:
                    continue
                c = contact_vers_contact(r, siren, libelle)
                if c:
                    contacts.append(c)
                    n_ct += 1

        stats[fichier] = (n_org, n_ct)
        print("  %-34s %6d organisations | %6d contacts" % (fichier, n_org, n_ct))

    with io.open(sortie, "w", encoding="utf-8", newline="\n") as f:
        for e in orgs:
            f.write(json.dumps(e, ensure_ascii=False) + "\n")
        for c in contacts:
            f.write(json.dumps(c, ensure_ascii=False) + "\n")

    print("")
    print("total  : %d organisations, %d contacts" % (len(orgs), len(contacts)))
    print("sortie : %s (%.1f Mo)" % (sortie, os.path.getsize(sortie) / 1048576))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
