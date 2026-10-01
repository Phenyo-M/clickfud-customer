/* ============================================================
   CLICKFUD — My Orientation: destination search provider

   Routing and Map provider abstractions (Google Routes API / Maps
   JavaScript SDK) were removed earlier — My Orientation performs no
   mapping/routing itself at all. Once a destination is found, it's
   handed off entirely to the real Google Maps app/website via a plain
   URL — see js/orientation-maps-launcher.js. No API key, no Google
   Cloud project, no billing, for search OR navigation.

   This file answers "what UP locations match this search, on this
   campus?" from a curated, hand-written location dataset (not scraped,
   not from any live API — see LOCATIONS below) using a proper token-
   based search engine (searchScore below), not a plain substring
   check. The dataset is intentionally structured as one record per
   location — id/name/campus/category/building/aliases — specifically
   so it can keep growing (more buildings, more campuses) without ever
   touching the search algorithm itself. The actual, accurate location
   is resolved by Google Maps at navigate time, from the destination's
   name + campus context — never from this file's own approximate
   coordinates (see orientation-maps-launcher.js for why).
   ============================================================ */
window.App = window.App || {};
App.Orientation = App.Orientation || {};

App.Orientation.Providers = (function () {
  // ---------------- Hatfield campus — official map data ----------------
  // Transcribed from the University of Pretoria's own published Hatfield
  // campus map/building index (the numbered legend + grid references,
  // e.g. "C6") — the app owner's own source, not a guess. `ref` below is
  // that map grid reference, kept only as informative "roughly where on
  // campus" context (shown in the address text) — the actual navigation
  // destination sent to Google Maps is always built from the name + full
  // campus name (see orientation-maps-launcher.js), never this ref or
  // any coordinate. A few well-known abbreviations get an explicit alias
  // (e.g. "EMS", "IT") where the official name itself wouldn't
  // tokenize-match them; everything else relies on the search engine's
  // own multi-word/prefix matching against the real name alone.
  function categorizeHatfieldBuilding(name) {
    const n = name.toLowerCase();
    if (/library/.test(n)) return 'Library';
    if (/lecture hall|auditorium|theatre|amphitheatre|\bhall\b|club hall/.test(n)) return 'Lecture Venue';
    if (/chapel|monastery/.test(n)) return 'Religious';
    if (/health services|clinic/.test(n)) return 'Clinic';
    if (/administration|student affairs|student service|visitors.? reception|transformation office|residence affairs|graduate centre|conference centre/.test(n)) return 'Admin Building';
    return 'Faculty Building';
  }

  const HATFIELD_BUILDINGS = [
    ['67 Duxbury Road', 'C6'], ['Administration Building', 'C1'], ['AE du Toit Auditorium and Annexe', 'A2'],
    ['Agriculture Annexe', 'D5'], ['Agricultural Sciences Building', 'D6'], ['Akanyang', 'C5'],
    ['Amphitheatre and Musaion', 'C3'], ['Aula and Rautenbach Hall', 'B3'], ['Bateman Building', 'A3'],
    ['Botany Building', 'A3'], ['Building 1 (South Campus)', 'D1'], ['Building 2 (South Campus)', 'D2'],
    ['Building 3 (South Campus)', 'D1'], ['Building 4 (South Campus)', 'D2'], ['Building 5 (South Campus)', 'D2'],
    ['Building 6 (South Campus)', 'D2'], ['Building 7 (South Campus)', 'D2'], ['Building 8 (South Campus)', 'D2'],
    ['Building 9 (South Campus)', 'D3'], ['CEFIM Building', 'A3'], ['Centenary Building', 'B5'],
    ["Chancellor's Building", 'C3'], ['Chapel', 'C5'], ['Chemistry Building', 'C2'], ['Club Hall', 'C3'],
    ['Communication Pathology Building', 'C3'], ['Conference Centre', 'C5'], ['Drama Building', 'D5'],
    ['Economic and Management Sciences Building', 'C4'], ['Engineering 1 Building', 'B2'],
    ['Engineering 2 Building', 'B2'], ['Engineering 3 Building', 'C2'], ['FABI 1', 'C6'], ['FABI 2', 'C6'],
    ['Geography Building', 'B3'], ['Graduate Centre', 'C5'], ['Heavy Machinery Laboratories', 'B2'],
    ['Humanities Building', 'C4'], ['Information Technology Building', 'C5'], ['Javett-UP Art Centre', 'D2'],
    ['Kya Rosa', 'C4'], ['Law Building', 'B5'], ['Law Clinic', 'B6'], ['Lecture Halls (EMS)', 'C5'],
    ['Lier Theatre', 'D5'], ['Louw Lecture Hall', 'B3'], ['Marketing Services Building', 'C3'],
    ['Masker Theatre', 'D5'], ['Mathematics Building', 'A3'], ['Merensky 2 Library', 'C3'],
    ['Monastery Hall', 'C5'], ['Muller Lecture Hall', 'C3'], ['Music Building', 'C2'],
    ['Natural Sciences 1 Building', 'B3'], ['Natural Sciences 2 Building', 'B3'],
    ['North Hall (Chemistry Building)', 'B4'], ['Old Agriculture Building', 'A4'], ['Old Arts Building', 'B3'],
    ['Old College House', 'B3'], ['Old Chemistry Building', 'C4'], ['Old Merensky Library', 'C3'],
    ['Plant Sciences Complex', 'C6'], ['Residence Affairs & Accommodation', 'C6'], ['Roos Lecture Hall', 'C3'],
    ['Sanlam Auditorium', 'C5'], ['Sci-Enza Centre', 'A4'], ['South Hall (Chemistry Building)', 'B4'],
    ['Stoneman Building', 'A3'], ['Student Affairs Building', 'B4'], ['Student Centre Building', 'C4'],
    ['Student Gallery and Arts Square', 'C2'], ['Student Health Services', 'B4'],
    ['Student Service Centre Building', 'C4'], ['Technical Services Building', 'A4'], ['Theology Building', 'C3'],
    ['Thuto Building', 'B4'], ['Transformation Office', 'B4'], ['Tukkiewerf', 'C4'],
    ['Van der Bijl Lecture Hall', 'C3'], ['Van der Graaf Accelerator', 'B3'], ['Vetman Building', 'A3'],
    ["Visitors' Reception", 'C4'], ['Visual Arts Building', 'C2'], ['Zoology Building', 'B4'],
  ];
  // A few official names a student would naturally abbreviate to
  // something that doesn't literally prefix-match the real name.
  const HATFIELD_BUILDING_ALIASES = {
    'Economic and Management Sciences Building': ['ems', 'commerce', 'business school'],
    'Lecture Halls (EMS)': ['ems'],
    'Information Technology Building': ['it', 'computer science', 'informatics', 'cs'],
    'Javett-UP Art Centre': ['art gallery', 'art museum', 'javett'],
    'Sci-Enza Centre': ['science centre'],
    'Administration Building': ['admin'],
    'Amphitheatre and Musaion': ['drama', 'music venue'],
  };

  const HATFIELD_RESIDENCES = [
    ['Asterhof', 'A6'], ['Erica', 'B5'], ['House Khutso', 'B6'], ['House Mags', 'B6'], ['House Nala', 'B5'],
    ['Invicta', 'D6'], ['Jakaranda', 'A5'], ['Madelief', 'A6'], ['Nerina', 'D6'], ['Protea Mbalenhle', 'C7'],
    ['Vergeet-my-nie', 'B5'], ['Xayata', 'D7'],
  ];

  const HATFIELD_ENTRANCES = [
    'Main Entrance', 'Javett Entrance', 'South Campus Entrance', 'Entrance — Festival/Prospect side',
    'Entrance — Lynnwood side', 'Entrance — Duxbury/Lunnon side', 'Pedestrian Entry', 'Vehicle Access',
    'Drop-Off', 'Pedestrian Entrances', 'Vehicle Entrances',
  ];

  const HATFIELD_PARKING = [
    'Parking', "Visitors' Parking", 'Parking for Disabled Persons', 'Student Parking', 'VP — Visitors’ Parking',
    'Disabled Parking', 'Parking around Ring Road', 'Parking around South Campus', 'Parking near Engineering',
    'Parking near Lynnwood', 'Parking near Duxbury', 'To Parkade',
  ];

  const HATFIELD_SERVICES = [
    'Bus Stop', 'UP Information Desk', 'Public Toilets', 'Toilets for Disabled Persons',
    'Retail and Dining Facilities', 'Ring Road', 'Walkways',
  ];

  function buildHatfieldLocations() {
    const buildings = HATFIELD_BUILDINGS.map(([name, ref]) => ({
      name, category: categorizeHatfieldBuilding(name), building: ref,
      aliases: HATFIELD_BUILDING_ALIASES[name] || [],
    }));
    const residences = HATFIELD_RESIDENCES.map(([name, ref]) => ({
      name, category: 'Residence', building: ref, aliases: ['res', 'dorm', 'residence'],
    }));
    const entrances = HATFIELD_ENTRANCES.map((name) => ({ name, category: 'Entrance', building: '', aliases: [] }));
    const parking = HATFIELD_PARKING.map((name) => ({ name, category: 'Parking', building: '', aliases: [] }));
    const services = HATFIELD_SERVICES.map((name) => ({ name, category: 'Campus Service', building: '', aliases: [] }));
    return [...buildings, ...residences, ...entrances, ...parking, ...services];
  }

  // ---------------- Other campuses — official map data ----------------
  // Same reasoning as Hatfield above: transcribed from the app owner's
  // own official campus map data for each campus, deduplicated against
  // itself (the source lists group the same location under multiple
  // headings — e.g. a residence under both "Residences" and "Other
  // Facilities") and filtered to actual named, navigable places. Purely
  // generic map-legend labels that don't refer to one specific place
  // ("UP Buildings", "Other Buildings", a bare "Roads") are left out —
  // handing "UP Buildings" to Google Maps as a destination would be
  // meaningless, not a real navigation target. Unlike Hatfield, these
  // sources don't give a reliable name-to-grid-reference pairing (the
  // grid codes are listed separately, unnumbered), so no `building`
  // reference is attached here rather than guessing one.
  function categorizeGenericBuilding(name) {
    const n = name.toLowerCase();
    if (/library/.test(n)) return 'Library';
    if (/hospital|clinic\b/.test(n)) return 'Clinic';
    if (/lecture hall|auditorium|\bhall\b/.test(n)) return 'Lecture Venue';
    if (/administration|admin\b|finance|human resources|marketing and communication|faculty manager|\bdean\b|deputy dean/.test(n)) return 'Admin Building';
    return 'Faculty Building';
  }

  function buildCampusLocations({ buildings = [], sports = [], residences = [], roads = [], entrances = [], parking = [], services = [], other = [] }) {
    const seen = new Set();
    const mk = (name, category, aliases) => ({ name, category, building: '', aliases: aliases || [] });
    const dedupe = (list) => list.filter((name) => {
      const key = name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return [
      ...dedupe(buildings).map((n) => mk(n, categorizeGenericBuilding(n))),
      ...dedupe(sports).map((n) => mk(n, 'Sports Centre', ['sport'])),
      ...dedupe(residences).map((n) => mk(n, 'Residence', ['res', 'dorm', 'residence'])),
      ...dedupe(roads).map((n) => mk(n, 'Road')),
      ...dedupe(entrances).map((n) => mk(n, 'Entrance')),
      ...dedupe(parking).map((n) => mk(n, 'Parking')),
      ...dedupe(services).map((n) => mk(n, 'Campus Service')),
      ...dedupe(other).map((n) => mk(n, 'Other')),
    ];
  }

  function buildGroenkloofLocations() {
    return buildCampusLocations({
      buildings: [
        'Aldoel Building', 'Auditorium', 'Boma', 'Cricket Club House', 'Cleaners’ Office', 'Director: TuksRes',
        'Faculty Library: Education', 'Guest Houses 1, 2 and 3', 'Kentucky Club House', 'Administration',
        'Tirisano Club House', 'Guest House 4', 'Natural Sciences', 'Normal Hall', 'Pavilion', 'Lecture Halls',
        'Letlotlo Building', 'Sports Centre', 'Sports-fields Ablutions', 'Recycling Station',
        'Site-contractor Complex', 'Technika Tirisano', 'Zinnia', 'Student Centre', 'Staff Accommodation',
        'Hayani', 'Jakaranda Club House', 'Stores', 'Technical Services Ikageng', 'TuksRes: Dining Hall', 'Dam',
      ],
      sports: [
        'Swimming Pool', 'Rugby / Football / Athletics', 'Basketball', 'Rugby / Football', 'Cricket', 'Netball',
        'Hockey', 'Tennis', 'Tennis / Netball',
      ],
      residences: [
        'Guest Houses 1, 2 and 3', 'Guest House 4', 'Staff Accommodation', 'Director: TuksRes',
        'TuksRes: Dining Hall', 'Jakaranda Club House', 'Kentucky Club House', 'Tirisano Club House',
      ],
      roads: ['Leyds', 'Sibelius', 'George Storrar (M7)', 'Ring Road'],
      entrances: ['Main Entrance', 'Vehicle Access', 'Pedestrian Entry'],
      parking: ['Parking', 'Visitors’ Parking', 'Parking for Disabled Persons', 'Student Parking', 'VP — Visitors’ Parking'],
      services: ['UP Information Desk', 'Public Toilets', 'Toilets for Disabled Persons', 'Retail and Dining Facilities', 'Walkways'],
    });
  }

  function buildPrinshofLocations() {
    return buildCampusLocations({
      buildings: [
        'Health Sciences Building', 'Occupational Therapy', 'Construction Unit', 'HW Snyman North',
        'Oral and Dental Hospital', 'Tshwane District Hospital', 'HW Snyman South', 'Pathology Building',
        'Tšwelopele Building', 'Prinshof IT', 'Test Laboratory', 'Steve Biko Academic Hospital',
        'Animal Laboratory', 'Basic Medical Sciences (BMS)', 'BSL 3 Laboratory',
      ],
      residences: [
        'International Students’ Apartments', 'Hippokrates', 'Curelitzia', 'House Ukuthula Block A to F',
        'Tuks Bophelong Communal Facility', 'House Ukuthula Hall', 'Tuks Bophelong Block A to E',
      ],
      sports: ['Basketball', 'Tennis', 'Football', 'Swimming Pool'],
      roads: ['Malan', 'Steve Biko (Voortrekker)', 'Rose', 'Union', 'Annie Botha', 'Soutpansberg', 'Dr Savage', 'Perks', 'Bophelo', 'Malherbe'],
      entrances: ['Entrance', 'Vehicle Access', 'Pedestrian Entry'],
      parking: ['Parking', 'Visitors’ Parking', 'Parking for Disabled Persons', 'Student Parking', 'VP — Visitors’ Parking'],
      services: ['UP Information Desk', 'Public Toilets', 'Toilets for Disabled Persons', 'Retail and Dining Facilities'],
    });
  }

  function buildOnderstepoortLocations() {
    return buildCampusLocations({
      buildings: [
        'Outpatients', 'Companion Animal Clinical Studies', 'Reproduction', 'Lesedi Complex',
        'Multi-disciplinary Laboratory', 'Skills Laboratory', 'Faculty Student Administration and Support',
        'Student Study Centre/Cafeteria', 'Sir Arnold Theiler Building', 'Lecture Halls', 'Computer Laboratory',
        'Boardroom', 'Copy Centre', 'Jotello F Soga Library', 'Research Commons', 'Deputy Deans', 'Faculty Manager',
        'Human Resources', 'Marketing and Communication', 'Dean', 'Veterinary Genetics Laboratory',
        'Veterinary Academic Hospital', 'Post Mortems', 'Pathology', 'Veterinary Public Health', 'Milk Laboratory',
        'Support Services Complex', 'Feed Store', 'Transport and Messenger Services', 'Technical Workshop',
        'Pathology and Veterinary Public Health Complex', 'Onderstepoort Veterinary Animal Research Unit (OVARU)',
        'Paraclinical Building', 'Pharmacology and Toxicology', 'Phytomedicine', 'Veterinary Tropical Diseases',
        'Production Animal Studies Building', 'Tropical Diseases Laboratory Complex', 'Old Faculty Building',
        'Ruminant Health', 'Centre for Veterinary Wildlife Studies', 'Finance', 'Veterinary Physiology',
        'Electron Microscopy Unit', 'Poultry Experimental Facility', 'Equine Research Centre', 'Anatomy Building',
        'Onderstepoort Veterinary Institute (OVI)', 'Onderstepoort Biological Products (not part of UP)',
      ],
      sports: [
        'Ablution Facilities at Sports Grounds', 'Clubhouse', 'Squash Courts', 'Dining Hall and Recreation Facilities',
        'Gymnasium', 'Tennis', 'Netball & Basketball', 'Swimming Pool', 'Rugby',
      ],
      residences: [
        'OTAU Stable Complex', 'OP Village Block A to T', 'Onderstepoort Houses No 1 to 9',
        'House Parents’ Residence', 'Postgraduate Student Centre',
      ],
      roads: ['M35 (Soutpan)', 'Sefako Makgatho (Zambesi)', 'R101 (Lavender)', 'R566', 'N1'],
      entrances: ['Main Entrance', 'Entrance to Residences', 'Vehicle Access', 'Pedestrian Entry'],
      parking: ['Parking', 'Visitors’ Parking', 'Parking for Disabled Persons', 'Student Parking', 'VP — Visitors’ Parking'],
      services: ['UP Information Desk', 'Public Toilets', 'Toilets for Disabled Persons', 'Retail and Dining Facilities', 'Animal Enclosures'],
    });
  }

  function buildMamelodiLocations() {
    return buildCampusLocations({
      buildings: [
        'Administration', 'Animal Health Clinic', 'Arena', 'Chemistry', 'Business Clinic',
        'Computer Science Centre', 'Conference Hall', 'Education', 'Lecture Hall Block A', 'Academic Offices',
        'Lecture Hall Block B', 'Mae Jemison Reading Room', 'Lecture Hall Block C', 'Physics', 'Library',
        'Registration Hall', 'Social Sciences', 'Geography',
      ],
      sports: ['Football', 'Netball / Basketball', 'Cruyff Court'],
      roads: ['Hinterland', 'Ramabulane', 'Solomon Mahlangu (M10)', 'Molokolok', 'Ring Road'],
      entrances: ['Main Entrance', 'Gate House', 'Vehicle Access', 'Pedestrian Entry'],
      parking: ['Parking', 'Visitors’ Parking', 'Parking for Disabled Persons', 'Student Parking', 'VP — Visitors’ Parking'],
      services: ['UP Information Desk', 'Public Toilets', 'Toilets for Disabled Persons', 'Retail and Dining Facilities', 'Walkways'],
    });
  }

  // ---------------- Location dataset ----------------
  // One record per real, named UP location. `aliases` covers common
  // abbreviations/alternate names/typo-tolerant word stems a student
  // might type instead of the official name — these feed the SAME
  // search engine as `name`/`category`/`building`, never a separate
  // hard-coded suggestion list. Hatfield is the app owner's own
  // official campus map data (see above); the remaining campuses are
  // still a smaller best-effort curated set — not independently
  // geocoded (see the coordinate-accuracy note in
  // orientation-maps-launcher.js); add/correct entries here freely, the
  // search and UI need no changes either way.
  const LOCATIONS = {
    hatfield: buildHatfieldLocations(),
    hillcrest: [
      { name: 'LC de Villiers Stadium', category: 'Sports Centre', building: 'LC de Villiers', aliases: ['stadium', 'athletics'] },
      { name: 'Hillcrest Residence', category: 'Residence', building: 'Hillcrest Residence', aliases: ['res', 'dorm'] },
      { name: 'High Performance Centre', category: 'Sports Centre', building: 'HPC', aliases: ['gym', 'sport', 'fitness'] },
      { name: 'Hillcrest Swimming Pool', category: 'Sports Centre', building: 'Aquatics Centre', aliases: ['pool', 'swimming', 'aquatics'] },
    ],
    groenkloof: buildGroenkloofLocations(),
    prinshof: buildPrinshofLocations(),
    onderstepoort: buildOnderstepoortLocations(),
    mamelodi: buildMamelodiLocations(),
    gibs: [
      { name: 'GIBS Main Building', category: 'Faculty Building', building: 'GIBS Main Building', aliases: ['gibs', 'business school'] },
      { name: 'GIBS Auditorium', category: 'Lecture Venue', building: 'GIBS Auditorium', aliases: ['auditorium', 'theatre'] },
      { name: 'GIBS Library', category: 'Library', building: 'GIBS Library', aliases: ['library'] },
      { name: 'GIBS Parking', category: 'Parking', building: 'GIBS Parking', aliases: ['parking'] },
    ],
  };

  // Fixed, small offsets from each campus centre — purely so results
  // have SOME coordinate for on-screen distance context (e.g. the
  // wrong-location check). Deterministic (derived from the location's
  // own name), not random, and — as documented above — never sent to
  // Google Maps as the actual destination.
  function offsetFor(name, index) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
    const angle = (hash % 360) * (Math.PI / 180);
    const radius = 0.0006 + (index % 8) * 0.0007;
    return { lat: Math.cos(angle) * radius, lng: Math.sin(angle) * radius };
  }

  // ---------------- Per-campus source provenance ----------------
  // Exactly what it says — never inflated. Hatfield/Groenkloof/Prinshof/
  // Onderstepoort/Mamelodi were transcribed directly from official UP
  // campus map data the app owner provided; Hillcrest and GIBS are still
  // a small best-effort list that has NOT been independently checked
  // against an official UP source, and is marked as such everywhere it
  // surfaces (status NEEDS_VERIFICATION on every record from those two).
  const CAMPUS_SOURCE_META = {
    hatfield: { sourceType: 'official_up_campus_map', sourceName: 'Official UP Hatfield campus map (provided directly by app owner)', lastVerified: '2026-09-25', verified: true },
    groenkloof: { sourceType: 'official_up_campus_map', sourceName: 'Official UP Groenkloof campus map (provided directly by app owner)', lastVerified: '2026-09-25', verified: true },
    prinshof: { sourceType: 'official_up_campus_map', sourceName: 'Official UP Prinshof campus map (provided directly by app owner, map dated April 2019)', lastVerified: '2026-09-25', verified: true },
    onderstepoort: { sourceType: 'official_up_campus_map', sourceName: 'Official UP Onderstepoort campus map (provided directly by app owner, map dated June 2019)', lastVerified: '2026-09-25', verified: true },
    mamelodi: { sourceType: 'official_up_campus_map', sourceName: 'Official UP Mamelodi campus map (provided directly by app owner, map dated July 2018)', lastVerified: '2026-09-25', verified: true },
    // Hillcrest and GIBS are confirmed as two of UP's official seven
    // campuses (up.ac.za/campuses-maps-directions, checked via research
    // agent 2026-09-25 — indexed snippets of UP's own page, not a direct
    // fetch, since www.up.ac.za blocked direct requests that session).
    // Their OWN campus-map PDFs could not be confirmed live (the indexed
    // URLs 404'd), so the building-level lists below remain a small
    // best-effort set, unlike the other five campuses' official map data.
    hillcrest: { sourceType: 'partially_verified', sourceName: 'Campus confirmed official (up.ac.za/campuses-maps-directions); building-level map not yet independently confirmed', lastVerified: '2026-09-25', verified: false },
    gibs: { sourceType: 'partially_verified', sourceName: 'Campus confirmed official (up.ac.za/campuses-maps-directions); building-level map not yet independently confirmed', lastVerified: '2026-09-25', verified: false },
  };

  // ---------------- Category codes ----------------
  // The fixed vocabulary every destination gets tagged with, in addition
  // to the human-readable `category` text already used for display.
  // Name-based overrides catch the specific, common cases (toilets, food,
  // transport, libraries, labs) that a single category string like
  // "Campus Service" would otherwise lump together too coarsely.
  function deriveCategoryCode(name, category) {
    const n = name.toLowerCase();
    if (/toilet/.test(n)) return 'TOILET';
    if (/retail and dining|food court|cafeteria|dining hall|restaurant|piazza/.test(n)) return 'FOOD';
    if (/bus stop|walkway|ring road|\bm\d+\b|\br\d{2,}\b|\bn1\b/.test(n)) return 'TRANSPORT';
    if (/information desk/.test(n)) return 'STUDENT_SERVICES';
    if (/library/.test(n)) return 'LIBRARY';
    if (/laborator(y|ies)/.test(n)) return 'LABORATORY';
    switch (category) {
      case 'Lecture Venue': return 'LECTURE_HALL';
      case 'Residence': return 'RESIDENCE';
      case 'Sports Centre': return 'SPORTS';
      case 'Parking': return 'PARKING';
      case 'Entrance': return 'ENTRANCE';
      case 'Clinic': return 'HEALTH';
      case 'Admin Building': return 'ADMINISTRATION';
      case 'Road': return 'TRANSPORT';
      case 'Religious': return 'LANDMARK';
      case 'Student Centre': return 'STUDENT_SERVICES';
      case 'Faculty Building': return 'FACULTY';
      default: return 'OTHER';
    }
  }

  // `item.building` doubles as the official map grid reference for
  // Hatfield entries (e.g. "B2") — shown to the student as useful
  // "roughly where on campus" context, but NEVER part of what's sent to
  // Google Maps as the destination (see orientation-maps-launcher.js,
  // which only ever uses name + campus). Fields below follow the
  // destination schema the app owner specified — every field that would
  // require data this app doesn't actually have (a real geocoded
  // coordinate, a real Google Place ID) is left explicitly unset/flagged
  // rather than filled with a plausible-looking guess.
  function mockPlaceRecord(campus, item, i) {
    const offset = offsetFor(item.name, i);
    const isGridRef = item.building && /^[A-Z]\d+$/.test(item.building);
    const meta = CAMPUS_SOURCE_META[campus.id] || { sourceType: 'unverified_best_effort', sourceName: 'Not yet checked against an official UP source', lastVerified: null, verified: false };
    const categoryCode = deriveCategoryCode(item.name, item.category);
    return {
      id: `mock_${campus.id}_${i}`,
      name: item.name,
      official_name: item.name,
      campus: campus.name,
      category: item.category,       // human-readable, unchanged — existing UI reads this
      category_code: categoryCode,   // fixed enum (section 11) — ACADEMIC/LECTURE_HALL/FACULTY/LIBRARY/etc.
      building: item.building || item.name,
      building_code: isGridRef ? item.building : null,
      map_reference: isGridRef ? item.building : null,
      address: isGridRef ? `${item.name} (Map ref ${item.building}), ${campus.fullName}` : `${item.name}, ${campus.fullName}`,
      // Approximate on-screen-only positions (see offsetFor above) — NEVER
      // independently geocoded, so always flagged rather than presented
      // as real coordinates. Never sent to Google Maps as a destination.
      latitude: campus.center.lat + offset.lat,
      longitude: campus.center.lng + offset.lng,
      coords: { lat: campus.center.lat + offset.lat, lng: campus.center.lng + offset.lng },
      coordinates_status: 'needs_verification',
      google_place_id: null,
      google_maps_available: 'unverified', // this app has not individually checked each destination against Google Places — see the research report
      official_up_source: meta.sourceName,
      map_source: meta.sourceName,
      source_type: meta.sourceType,
      aliases: item.aliases || [],
      search_keywords: item.aliases || [],
      navigation_type: 'walking',
      is_residence: item.category === 'Residence',
      is_lecture_venue: categoryCode === 'LECTURE_HALL',
      is_student_facility: ['STUDENT_SERVICES', 'FOOD', 'HEALTH', 'TOILET'].includes(categoryCode),
      is_public: true,
      is_accessible: null, // not reliably known per-destination — never guessed
      status: meta.verified ? 'ACTIVE' : 'NEEDS_VERIFICATION',
      last_verified: meta.lastVerified,
      source: 'mock',
    };
  }

  // ---------------- Search engine ----------------
  // A real token-based matcher, not a single substring check — this is
  // what makes "eng 3" find "Engineering III", "law lib" find "Law
  // Library", and a single letter like "L" or "T" broadly match
  // anything with a word starting with that letter. Every query WORD
  // must match somewhere (as a whole-string substring, or as the start
  // of some word in the location's name/category/building/aliases) —
  // nothing here special-cases specific words like "law" or
  // "engineering"; add a new LOCATIONS entry and it's searchable by
  // the exact same rules with zero code changes.
  function tokenize(text) {
    return String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  }

  function searchScore(queryTokens, item) {
    const nameLower = item.name.toLowerCase();
    const nameTokens = tokenize(item.name);
    const haystackText = [item.name, item.category, item.building, ...(item.aliases || [])].join(' ').toLowerCase();
    const haystackTokens = tokenize(haystackText);
    const queryJoined = queryTokens.join(' ');

    for (const qt of queryTokens) {
      const tokenPrefixMatch = haystackTokens.some((ht) => ht.startsWith(qt));
      const substringMatch = haystackText.includes(qt);
      if (!tokenPrefixMatch && !substringMatch) return null; // this query word matches nothing at all here — exclude
    }

    let score = 0;
    if (nameLower === queryJoined) score += 100; // exact name match
    else if (nameLower.startsWith(queryJoined)) score += 60; // whole query is a prefix of the name
    queryTokens.forEach((qt) => {
      if (nameTokens.some((nt) => nt === qt)) score += 20; // a query word exactly matches a whole word in the name
      else if (nameTokens.some((nt) => nt.startsWith(qt))) score += 12; // a query word prefixes a word in the name
      else if (nameLower.includes(qt)) score += 6; // query word appears somewhere in the name
      else score += 2; // only matched via category/building/alias — still relevant, ranked lower
    });
    return score;
  }

  function scoredResultsFor(campus, queryTokens) {
    const pool = LOCATIONS[campus.id] || [];
    return pool
      .map((item, i) => ({ item, i, score: searchScore(queryTokens, item) }))
      .filter((x) => x.score !== null)
      .sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name));
  }

  // ---------------- Quick-search suggestion chips ----------------
  // The chips shown under "Where are you going?" before the student has
  // typed anything — one real destination per useful category, in this
  // priority order, drawn from the exact same LOCATIONS pool the search
  // box itself queries (deriveCategoryCode is the same fixed vocabulary
  // mockPlaceRecord tags every real search result with), so the chips
  // and the search results can never disagree about what exists on a
  // given campus. A category with nothing real on this campus is simply
  // skipped — never padded with an invented placeholder — which is why
  // a smaller campus (Hillcrest, GIBS) naturally ends up with fewer
  // chips than Hatfield rather than a same-length generic list.
  const SUGGESTION_CATEGORY_PRIORITY = [
    'LECTURE_HALL', 'LIBRARY', 'FACULTY', 'STUDENT_SERVICES', 'FOOD',
    'RESIDENCE', 'SPORTS', 'PARKING', 'HEALTH', 'ADMINISTRATION', 'LANDMARK',
  ];

  // Bare street-address-style entries (e.g. "67 Duxbury Road") are real,
  // searchable locations, but make poor "tap this to try a search" chips
  // — skipped only when picking a category's representative chip, never
  // excluded from search itself.
  function looksLikeSuggestionChip(name) { return !/^\d+\s/.test(name); }

  function suggestedSearchesFor(campus, limit) {
    const max = limit || 8;
    const pool = (campus && LOCATIONS[campus.id]) || [];
    const byCategory = new Map();
    pool.forEach((item) => {
      const code = deriveCategoryCode(item.name, item.category);
      if (byCategory.has(code) || !looksLikeSuggestionChip(item.name)) return;
      byCategory.set(code, item.name);
    });
    const picks = [];
    for (const code of SUGGESTION_CATEGORY_PRIORITY) {
      if (picks.length >= max) break;
      const name = byCategory.get(code);
      if (name) picks.push(name);
    }
    return picks;
  }

  // Every real venue name for a campus, unfiltered/unranked — used to
  // populate a native <datalist> (e.g. My Timetable's Venue field) so
  // the browser's own autocomplete can filter as the student types with
  // no extra debounce/network/re-render machinery of its own, while
  // still never preventing a venue that isn't in this list from being
  // typed and saved. Same LOCATIONS pool searchPlaces/suggestedSearches
  // already read — never a second venue list.
  function allVenueNamesFor(campus) {
    const pool = (campus && LOCATIONS[campus.id]) || [];
    return pool.map((item) => item.name);
  }

  // searchPlaces({ query, campus }) -> { results: [...] } | { error }
  // Ranking within a single campus (section 8): exact name match, then
  // name-prefix, then per-token matches in the name itself, then
  // category/building/alias-only matches — all handled by searchScore's
  // weighting above. "Current campus first" is automatic here since this
  // never looks outside the given campus at all; see searchAllCampuses
  // below for when a broader search is actually warranted.
  const MockPlacesProvider = {
    // No artificial delay here — this searches a small in-memory list of
    // this app's own UP locations, not a real remote database call, so
    // there's no genuine latency to wait out. An earlier version added a
    // fake 150ms sleep purely "to exercise the UI's loading state"; that
    // was the actual cause of the search box's reported vibration (two
    // full re-renders in quick succession — one showing a transient
    // "Searching…" card, one replacing it moments later — each changing
    // the height of the area right under the input while the student was
    // still typing). Removed rather than papered over with an animation
    // fix, per the real request behind this.
    async searchPlaces({ query, campus }) {
      if (!campus) return { error: 'no_campus', message: 'Please choose a campus first.' };
      const q = String(query || '').trim();
      if (!q) return { results: [] };
      const queryTokens = tokenize(q);
      const scored = scoredResultsFor(campus, queryTokens);

      // Capped so the on-screen list stays glanceable (same reason
      // Google's own autocomplete shows a handful of suggestions, not
      // hundreds) — NOT a restriction on what can be found: a more
      // specific query narrows the same full dataset down naturally.
      const MAX_RESULTS = 20;
      const results = scored.slice(0, MAX_RESULTS).map(({ item, i }) => mockPlaceRecord(campus, item, i));
      return { results };
    },

    // searchAllCampuses({ query, currentCampus }) -> { results: [...] }
    // Global search across every campus (section 9) — each result is
    // still built by mockPlaceRecord (so it carries campus/category/
    // building exactly like a normal result) plus a distanceFromCurrentMeters
    // so the UI can show how far a same-name-but-wrong-campus result
    // actually is, e.g. "Humanities Building — Hatfield, 0 m away" vs.
    // "— Groenkloof, 4.2 km away". Results from the student's current
    // campus always sort first (ranking rule 1: current campus), then
    // everything else by relevance score.
    async searchAllCampuses({ query, currentCampus }) {
      const q = String(query || '').trim();
      if (!q) return { results: [] };
      const queryTokens = tokenize(q);
      const out = [];
      App.Orientation.CAMPUSES.forEach((campus) => {
        const scored = scoredResultsFor(campus, queryTokens);
        scored.forEach(({ item, i, score }) => {
          const record = mockPlaceRecord(campus, item, i);
          record.distanceFromCurrentMeters = currentCampus
            ? App.Orientation.distanceMeters(currentCampus.center, campus.center)
            : null;
          record._score = score;
          record._isCurrentCampus = !!currentCampus && campus.id === currentCampus.id;
          out.push(record);
        });
      });
      out.sort((a, b) => {
        if (a._isCurrentCampus !== b._isCurrentCampus) return a._isCurrentCampus ? -1 : 1; // current campus always first
        if (b._score !== a._score) return b._score - a._score;
        return a.name.localeCompare(b.name);
      });
      const MAX_RESULTS = 30;
      return { results: out.slice(0, MAX_RESULTS) };
    },

    // suggestedSearches(campus, limit) -> ['Real Name', ...] — synchronous,
    // no network/await, since it's just picking from the same in-memory
    // pool searchPlaces above already queries. See suggestedSearchesFor.
    suggestedSearches(campus, limit) {
      return suggestedSearchesFor(campus, limit);
    },

    // allVenueNames(campus) -> ['Real Name', ...] — see allVenueNamesFor.
    allVenueNames(campus) {
      return allVenueNamesFor(campus);
    },
  };

  return {
    Places: MockPlacesProvider,
  };
})();
