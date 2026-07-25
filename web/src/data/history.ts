/**
 * Time travel: documented milestones in how Europeans rebuilt their rivers.
 *
 * Each entry is a real, dated intervention with a location.  The geometry is a
 * point, not a reconstructed channel — historical river courses at continental
 * scale are not available as open data, so the app marks *where* and *when*
 * something changed rather than pretending to redraw the old channel.
 */
export interface HistoryEvent {
  year: number
  end?: number
  title: string
  river: string
  lon: number
  lat: number
  kind: 'straightening' | 'canal' | 'reservoir' | 'drainage' | 'barrier' | 'removal' | 'disaster'
  text: string
}

export const HISTORY: HistoryEvent[] = [
  { year: 1600, end: 1650, title: 'Draining the Fens', river: 'Great Ouse', lon: 0.15, lat: 52.5,
    kind: 'drainage', text: 'Cornelius Vermuyden cut the Old and New Bedford Rivers, converting England\'s largest wetland into farmland — and starting three centuries of peat shrinkage.' },
  { year: 1681, title: 'Canal du Midi opens', river: 'Garonne / Aude', lon: 2.0, lat: 43.4,
    kind: 'canal', text: 'The first modern summit-level canal linked the Atlantic to the Mediterranean across the Naurouze watershed divide.' },
  { year: 1717, title: 'Christmas Flood', river: 'Ems / Weser', lon: 7.5, lat: 53.4,
    kind: 'disaster', text: 'A North Sea storm surge killed thousands along the Dutch and German coast and reshaped estuary defences for a century.' },
  { year: 1817, end: 1876, title: 'Tulla straightens the Upper Rhine', river: 'Rhine', lon: 8.0, lat: 48.8,
    kind: 'straightening', text: 'Johann Gottfried Tulla cut off more than 2,000 meanders. The river lost about 80 km of length, gained speed, and dropped its bed by several metres.' },
  { year: 1846, end: 1880, title: 'Regulation of the Tisza', river: 'Tisza', lon: 20.2, lat: 46.9,
    kind: 'straightening', text: 'Pál Vásárhelyi\'s plan shortened the Tisza from about 1,400 km to under 1,000 km with 112 cut-offs — one of the largest river works ever undertaken.' },
  { year: 1869, title: 'Suez opens; Danube commission grows', river: 'Danube', lon: 29.6, lat: 45.2,
    kind: 'canal', text: 'The European Commission of the Danube dredged the Sulina arm into a deep-sea shipping channel, fixing the delta\'s main outlet.' },
  { year: 1892, title: 'Kiel Canal', river: 'Eider', lon: 9.6, lat: 54.3,
    kind: 'canal', text: 'A sea-level ship canal cut across Jutland, now the busiest artificial waterway in the world.' },
  { year: 1932, title: 'Afsluitdijk closes the Zuiderzee', river: 'IJssel', lon: 5.2, lat: 53.0,
    kind: 'barrier', text: 'A 32 km dam turned a tidal inlet into the freshwater IJsselmeer and cut the Rhine delta off from the Wadden Sea.' },
  { year: 1938, end: 1975, title: 'Rhône canalisation', river: 'Rhône', lon: 4.8, lat: 44.5,
    kind: 'reservoir', text: 'The Compagnie Nationale du Rhône built 19 barrage-and-bypass schemes, converting a braided Alpine river into a navigable staircase.' },
  { year: 1953, title: 'North Sea flood', river: 'Scheldt / Meuse', lon: 4.0, lat: 51.7,
    kind: 'disaster', text: 'A surge of over 4 m killed more than 2,500 people in the Netherlands, Belgium and England, and launched the Delta Works.' },
  { year: 1955, end: 1958, title: 'Kuibyshev and the Volga cascade', river: 'Volga', lon: 49.4, lat: 53.5,
    kind: 'reservoir', text: 'Eleven large dams turned the Volga into a chain of reservoirs; the river\'s natural spring flood, on which its floodplain depended, effectively ended.' },
  { year: 1956, title: 'Kakhovka reservoir fills', river: 'Dnipro', lon: 33.4, lat: 46.8,
    kind: 'reservoir', text: 'The last of six Dnieper dams flooded 2,155 km² of the lower valley and fed irrigation canals across southern Ukraine.' },
  { year: 1964, title: 'Ijsselmeer polders complete', river: 'IJssel', lon: 5.6, lat: 52.5,
    kind: 'drainage', text: 'Flevoland — the largest artificial island in the world — was pumped dry, adding 970 km² of land below sea level.' },
  { year: 1972, end: 1984, title: 'Iron Gates I and II', river: 'Danube', lon: 22.5, lat: 44.7,
    kind: 'reservoir', text: 'The Danube\'s gorge between Serbia and Romania was dammed. Ship locks replaced rapids and sturgeon lost their route to upstream spawning grounds.' },
  { year: 1982, title: 'Thames Barrier', river: 'Thames', lon: 0.04, lat: 51.5,
    kind: 'barrier', text: 'Ten movable gates protect London from storm surges; used a handful of times a year in the 1980s and dozens of times in recent decades.' },
  { year: 1986, title: 'Sandoz spill', river: 'Rhine', lon: 7.6, lat: 47.6,
    kind: 'disaster', text: 'Firefighting water carried 20 tonnes of pesticides into the Rhine at Basel, killing life along 400 km and triggering the Rhine Action Programme.' },
  { year: 1997, title: 'Oder flood', river: 'Oder', lon: 17.0, lat: 51.1,
    kind: 'disaster', text: 'The "Millennium flood" overwhelmed dykes in Czechia, Poland and Germany and shifted policy towards giving rivers room.' },
  { year: 1997, end: 1998, title: 'Loire dam removals', river: 'Loire', lon: 0.5, lat: 47.2,
    kind: 'removal', text: 'Saint-Étienne-du-Vigan and Maisons-Rouges were demolished — Europe\'s first large-scale dam removals for migratory fish.' },
  { year: 2002, title: 'Alqueva fills', river: 'Guadiana', lon: -7.5, lat: 38.2,
    kind: 'reservoir', text: 'Europe\'s largest artificial lake, 250 km², created for irrigation in the driest part of Iberia.' },
  { year: 2006, end: 2015, title: 'Room for the River', river: 'Rhine / Waal', lon: 5.9, lat: 51.9,
    kind: 'removal', text: 'The Netherlands moved dykes back and dug flood channels at more than 30 sites, deliberately trading land for flood safety.' },
  { year: 2009, title: 'Kárahnjúkar', river: 'Jökulsá á Dal', lon: -15.8, lat: 64.9,
    kind: 'reservoir', text: 'Iceland dammed a glacial river in its eastern highlands to power an aluminium smelter — the country\'s most contested engineering project.' },
  { year: 2018, end: 2022, title: 'Sélune dam removals', river: 'Sélune', lon: -1.2, lat: 48.6,
    kind: 'removal', text: 'Two hydro dams in Normandy were dismantled, reopening 90 km of river to salmon and eel.' },
  { year: 2021, title: 'Ahr valley flood', river: 'Rhine', lon: 7.1, lat: 50.5,
    kind: 'disaster', text: 'Up to 150 mm of rain in a day sent a wall of water down a small tributary valley, killing more than 130 people in Germany.' },
  { year: 2022, title: 'Po drought', river: 'Po', lon: 11.0, lat: 45.0,
    kind: 'disaster', text: 'Flows fell to a fifth of normal; salt water intruded 40 km upstream and irrigation was rationed across the Italian north.' },
  { year: 2023, title: 'Kakhovka dam destroyed', river: 'Dnipro', lon: 33.37, lat: 46.78,
    kind: 'disaster', text: 'The dam was breached during the war in Ukraine, draining the reservoir in days, flooding the lower valley and cutting irrigation to a region the size of Belgium.' },
]

export const KIND_COLOR: Record<HistoryEvent['kind'], string> = {
  straightening: '#ffb74d',
  canal: '#7ee0c0',
  reservoir: '#7c9cff',
  drainage: '#c9a0ff',
  barrier: '#63d2ff',
  removal: '#8ce87a',
  disaster: '#ff7b8a',
}
