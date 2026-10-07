# Data licences

The JSON files in this folder are written by `npm run data` (`tools/build-data.mjs`). Every file
carries a `meta` record `{kind, source, url, licence, asOf, generatedAt}` that applies to every
value in it. The code of MetaHospital is MIT licensed (see `../../LICENSE`); the data keeps the
licence of its source.

| File | Source | Licence | Attribution |
|---|---|---|---|
| `de-icu.json` | DIVI-Intensivregister open data, published daily by the Robert Koch-Institut: adult ICU capacity for Germany and the 16 Länder (last 28 days). https://github.com/robert-koch-institut/Intensivkapazitaeten_und_COVID-19-Intensivbettenbelegung_in_Deutschland | CC BY 4.0 | Robert Koch-Institut (2026): Intensivkapazitäten und COVID-19-Intensivbettenbelegung in Deutschland, Zenodo/GitHub. Values are passed through unchanged; only the adult rows and the last 28 days are kept. |
| `world.json` | World Bank World Development Indicators: hospital beds per 1,000 people (SH.MED.BEDS.ZS) and population (SP.POP.TOTL), latest year per economy. https://data.worldbank.org/indicator/SH.MED.BEDS.ZS | CC BY 4.0 | The World Bank: World Development Indicators. Only the latest non-empty year per economy is kept; regional aggregates are removed. |

Reference values that are cited in the views, not fetched (Official, each shown with its source):

| Value | Source | Licence |
|---|---|---|
| Germany: 1,840 hospitals on 2,755 sites, 473,606 beds (2024) | Destatis Krankenhausverzeichnis 2024, https://www.statistikportal.de/de/veroeffentlichungen/krankenhausverzeichnis | dl-de/by-2.0 |
| Berlin: 64 plan hospitals, 23,620 planned beds | Berlin hospital register WFS, https://gdi.berlin.de/services/wfs/krankenhaeuser | dl-de/zero-2.0 |
| Berlin: 85 hospitals, 20,119 set-up beds (2024) | Amt für Statistik Berlin-Brandenburg, Statistischer Bericht A IV 2 - j/24 | CC BY 3.0 DE |

Map geometry (in `src/data/`): Natural Earth via world-atlas (public domain), Berlin districts from Berliner Morgenpost Berlin-Geodaten (CC BY,
Amt für Statistik Berlin-Brandenburg).

Fonts (in `styles/fonts/`): Inter by The Inter Project Authors, SIL Open Font License 1.1 (`OFL.txt`).
