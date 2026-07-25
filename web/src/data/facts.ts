/**
 * Curated background on Europe's major rivers.
 *
 * Lengths, basin areas and mean discharges are published long-term figures
 * (national hydrological services, GRDC, ICPDR and equivalent basin
 * commissions).  They are shown next to the model's own numbers so the two can
 * be compared honestly.
 */
export interface RiverFact {
  name: string
  length?: number      // km
  basin?: number       // km²
  discharge?: number   // m³/s, long-term mean near the mouth
  source?: string
  summary: string
  tributaries?: string[]
  floods?: string
  ecology?: string
}

export const RIVER_FACTS: Record<string, RiverFact> = {
  Danube: {
    name: 'Danube', length: 2850, basin: 801463, discharge: 6500,
    source: 'Black Forest, Germany',
    summary: 'Europe\'s most international river: it rises where the Breg and Brigach meet at Donaueschingen and crosses or borders ten countries before splitting into the three arms of the Danube Delta.',
    tributaries: ['Inn', 'Tisza', 'Sava', 'Drava', 'Siret', 'Prut', 'Olt'],
    floods: 'Catastrophic Central European floods in 2002, 2006 and 2013; the 2013 crest at Passau was the highest since 1501.',
    ecology: 'The Danube Delta is Europe\'s largest reed bed and a UNESCO biosphere reserve; its migratory sturgeon are critically endangered, partly because the Iron Gates dams block their route upstream.',
  },
  Rhine: {
    name: 'Rhine', length: 1230, basin: 185000, discharge: 2330,
    source: 'Lake Toma, Swiss Alps',
    summary: 'The busiest waterway in the world and the spine of industrial Europe. Between 1817 and 1876 Johann Tulla straightened the Upper Rhine, cutting roughly 80 km from its length and destroying most of its braided floodplain.',
    tributaries: ['Aare', 'Neckar', 'Main', 'Moselle', 'Ruhr', 'Lippe'],
    floods: 'Severe floods in 1993 and 1995; the 2021 Ahr valley flash flood on a small tributary killed more than 130 people in Germany.',
    ecology: 'After the 1986 Sandoz chemical spill sterilised long reaches, an international salmon reintroduction programme brought Atlantic salmon back above Basel.',
  },
  Volga: {
    name: 'Volga', length: 3531, basin: 1360000, discharge: 8060,
    source: 'Valdai Hills, Russia',
    summary: 'The longest river in Europe and the largest by discharge. It never reaches an ocean — it ends in the Caspian Sea, 28 m below global sea level, making its basin the continent\'s great endorheic sink.',
    tributaries: ['Oka', 'Kama', 'Vetluga', 'Sura'],
    ecology: 'A cascade of eleven large reservoirs turned most of the river into slack water; beluga sturgeon lost almost all their spawning gravels.',
  },
  Elbe: {
    name: 'Elbe', length: 1094, basin: 148268, discharge: 870,
    source: 'Krkonoše mountains, Czechia',
    summary: 'Rises in the Giant Mountains as the Labe and reaches the North Sea past Hamburg, one of Europe\'s largest ports.',
    tributaries: ['Vltava', 'Saale', 'Havel', 'Mulde'],
    floods: 'The August 2002 flood inundated Dresden and Prague and remains one of the costliest natural disasters in German history.',
  },
  Loire: {
    name: 'Loire', length: 1006, basin: 117000, discharge: 840,
    source: 'Mont Gerbier de Jonc, Ardèche',
    summary: 'France\'s longest river, often called its last wild one: the middle Loire still shifts sandbanks freely, and its valley is a UNESCO World Heritage landscape.',
    tributaries: ['Allier', 'Cher', 'Vienne', 'Maine'],
    ecology: 'Removal of the Saint-Étienne-du-Vigan and Maisons-Rouges dams in the late 1990s reopened hundreds of kilometres to migrating salmon.',
  },
  'Rhône': {
    name: 'Rhône', length: 813, basin: 98000, discharge: 1710,
    source: 'Rhône Glacier, Valais',
    summary: 'Born from a retreating Alpine glacier, filtered through Lake Geneva, then almost entirely canalised by the Compagnie Nationale du Rhône for power and navigation.',
    tributaries: ['Saône', 'Isère', 'Durance', 'Ardèche'],
    ecology: 'Its Camargue delta is one of the Mediterranean\'s most important wetlands for flamingos and migratory birds.',
  },
  Seine: {
    name: 'Seine', length: 777, basin: 78650, discharge: 560,
    source: 'Source-Seine, Burgundy',
    summary: 'A gentle, low-gradient river whose slow flow made Paris navigable but also flood-prone; four large upstream reservoirs now buffer its winter peaks.',
    floods: 'The 1910 Great Flood of Paris put much of the city under water for weeks; 2016 and 2018 came close to repeating it.',
  },
  Po: {
    name: 'Po', length: 652, basin: 74000, discharge: 1540,
    source: 'Monviso, Piedmont',
    summary: 'Italy\'s longest river drains the whole southern flank of the Alps and the northern Apennines into the Adriatic through a rapidly subsiding delta.',
    tributaries: ['Ticino', 'Adda', 'Oglio', 'Mincio', 'Tanaro'],
    floods: 'The 2022 drought dropped the Po so low that Adriatic salt water pushed 40 km inland and wrecked the rice harvest.',
  },
  Vistula: {
    name: 'Vistula', length: 1047, basin: 194424, discharge: 1080,
    source: 'Barania Góra, Silesian Beskids',
    summary: 'Poland\'s national river, running the length of the country from the Carpathians to the Baltic at Gdańsk.',
    floods: 'The 1997 "Millennium flood" and 2010 flood both caused billions of euros of damage across the upper basin.',
  },
  Oder: {
    name: 'Oder', length: 854, basin: 118861, discharge: 570,
    source: 'Oderské vrchy, Czechia',
    summary: 'Forms much of the German–Polish border before emptying into the Szczecin Lagoon and the Baltic.',
    ecology: 'In summer 2022 a bloom of the toxic golden alga Prymnesium parvum, triggered by high salinity and low flow, killed hundreds of tonnes of fish.',
  },
  Dnipro: {
    name: 'Dnipro', length: 2201, basin: 504000, discharge: 1670,
    source: 'Valdai Hills, Russia',
    summary: 'The fourth-longest river in Europe, running through Belarus and Ukraine to the Black Sea.',
    floods: 'The destruction of the Kakhovka dam in June 2023 emptied a reservoir the size of the Great Salt Lake and flooded the lower valley.',
  },
  Don: { name: 'Don', length: 1870, basin: 425600, discharge: 900,
    source: 'Central Russian Upland',
    summary: 'A slow steppe river linked to the Volga by the Volga–Don Canal since 1952.' },
  Ebro: {
    name: 'Ebro', length: 930, basin: 85530, discharge: 430,
    source: 'Cantabrian Mountains',
    summary: 'Spain\'s largest river by flow, squeezed between the Pyrenees and the Iberian System in one of Europe\'s driest large basins.',
    ecology: 'Dams trap most of its sediment, so the Ebro Delta is subsiding and losing ground to the Mediterranean.',
  },
  Tejo: { name: 'Tejo', length: 1007, basin: 80100, discharge: 444,
    source: 'Sierra de Albarracín',
    summary: 'The Tagus/Tejo crosses Iberia from the Spanish meseta to a vast tidal estuary at Lisbon.' },
  Duero: { name: 'Duero', length: 897, basin: 98375, discharge: 700,
    source: 'Picos de Urbión',
    summary: 'The Douro carves the deepest gorges of the Iberian plateau and terraces its lower valley into port-wine country.' },
  Guadalquivir: { name: 'Guadalquivir', length: 657, basin: 57527, discharge: 164,
    summary: 'Andalusia\'s river, navigable to Seville, feeding the Doñana wetlands.' },
  Guadiana: { name: 'Guadiana', length: 742, basin: 67733, discharge: 79,
    summary: 'One of the most heavily regulated and water-stressed basins in Europe; the Alqueva reservoir, filled from 2002, is the continent\'s largest artificial lake.' },
  Thames: { name: 'Thames', length: 346, basin: 12935, discharge: 66,
    summary: 'Declared "biologically dead" in 1957 and now home to seals and seahorses again.' },
  Severn: { name: 'Severn', length: 354, basin: 11420, discharge: 107,
    summary: 'Britain\'s longest river; its estuary has the second-highest tidal range in the world and a famous tidal bore.' },
  Shannon: { name: 'Shannon', length: 360, basin: 16865, discharge: 208,
    summary: 'Ireland\'s longest river, draining a chain of limestone loughs across the midlands.' },
  Weser: { name: 'Weser', length: 452, basin: 46306, discharge: 327,
    summary: 'Formed where the Werra and Fulda meet at Hannoversch Münden.' },
  Meuse: { name: 'Meuse', length: 925, basin: 34548, discharge: 350,
    summary: 'A rain-fed river with sharp flood peaks; it shares its delta with the Rhine.',
    floods: 'July 2021 brought record discharges through Liège and Maastricht.' },
  Garonne: { name: 'Garonne', length: 602, basin: 55000, discharge: 650,
    source: 'Val d\'Aran, Pyrenees',
    summary: 'Joins the Dordogne at the Bec d\'Ambès to form the Gironde, western Europe\'s largest estuary.' },
  Glomma: { name: 'Glomma', length: 621, basin: 41918, discharge: 700,
    summary: 'Norway\'s longest and largest river, snow-fed with a strong June peak.' },
  Kemijoki: { name: 'Kemijoki', length: 550, basin: 51127, discharge: 556,
    summary: 'Finland\'s longest river; heavily harnessed for hydropower and frozen for months each winter.' },
  Neva: { name: 'Neva', length: 74, basin: 281000, discharge: 2500,
    summary: 'Only 74 km long but carrying the outflow of Lake Ladoga, Europe\'s largest lake — the third-largest river in Europe by discharge.' },
  'Severnaya Dvina': { name: 'Severnaya Dvina', length: 744, basin: 357052, discharge: 3332,
    summary: 'The Northern Dvina drains the taiga to the White Sea at Arkhangelsk; ice jams drive spectacular spring floods.' },
  Pechora: { name: 'Pechora', length: 1809, basin: 322000, discharge: 4100,
    summary: 'A near-pristine Arctic river running from the Urals to the Barents Sea.' },
  Kama: { name: 'Kama', length: 1805, basin: 507000, discharge: 4100,
    summary: 'The Volga\'s greatest tributary — by discharge it is arguably the main stem.' },
  Ural: { name: 'Ural', length: 2428, basin: 231000, discharge: 400,
    summary: 'Runs from the southern Urals to the Caspian and is often taken as part of the Europe–Asia boundary.' },
  Daugava: { name: 'Daugava', length: 1020, basin: 87900, discharge: 678,
    summary: 'The Western Dvina links the Valdai Hills to the Gulf of Riga.' },
  Neman: { name: 'Neman', length: 937, basin: 98200, discharge: 616,
    summary: 'Flows through Belarus and Lithuania into the Curonian Lagoon.' },
  Sava: { name: 'Sava', length: 990, basin: 97713, discharge: 1722,
    summary: 'The Danube\'s largest tributary by discharge, and the last big European river with extensive natural floodplain forest at Lonjsko Polje.' },
  Tisza: { name: 'Tisza', length: 966, basin: 156087, discharge: 794,
    summary: 'Straightened in the 19th century from 1,400 km to under 1,000 km — one of the largest river-engineering projects ever undertaken.' },
  Inn: { name: 'Inn', length: 518, basin: 26130, discharge: 735,
    summary: 'At Passau the Inn carries more water than the Danube it joins.' },
  Drava: { name: 'Drava', length: 749, basin: 40154, discharge: 577,
    summary: 'An Alpine river whose lower reaches form the "Amazon of Europe" biosphere reserve with the Mura and Danube.' },
  Adige: { name: 'Adige', length: 410, basin: 12100, discharge: 235,
    summary: 'Italy\'s second-longest river, draining the Dolomites.' },
  Tiber: { name: 'Tiber', length: 406, basin: 17375, discharge: 239,
    summary: 'Rome\'s river; its floods shaped the city until the great embankments of the 1870s.' },
  Dniester: { name: 'Dniester', length: 1352, basin: 72100, discharge: 310,
    summary: 'Runs from the Carpathians through Ukraine and Moldova to the Black Sea.' },
  Torne: { name: 'Torne', length: 522, basin: 40157, discharge: 380,
    summary: 'A free-flowing Nordic river forming the Sweden–Finland border, protected from hydropower development.' },
}

const ALIASES: Record<string, string> = {
  Donau: 'Danube', Dunaj: 'Danube', Duna: 'Danube', Dunav: 'Danube', Dunărea: 'Danube',
  Rhein: 'Rhine', Rijn: 'Rhine', Rhin: 'Rhine',
  'Wisła': 'Vistula', Wisla: 'Vistula',
  Odra: 'Oder', Dnieper: 'Dnipro', Dnepr: 'Dnipro',
  Tagus: 'Tejo', Tajo: 'Tejo', Douro: 'Duero',
  Maas: 'Meuse', 'Rhone': 'Rhône',
  'Northern Dvina': 'Severnaya Dvina',
  Tevere: 'Tiber', Etsch: 'Adige',
  Nemunas: 'Neman', Memel: 'Neman',
  'Western Dvina': 'Daugava', 'Zapadnaya Dvina': 'Daugava',
  Loira: 'Loire', Rin: 'Rhine',
}

export function lookupFacts(name?: string): RiverFact | null {
  if (!name) return null
  const key = ALIASES[name] ?? name
  return RIVER_FACTS[key] ?? null
}
