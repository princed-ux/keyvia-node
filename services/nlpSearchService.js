const nlpSearchService = {
  parse(query) {
    if (!query || typeof query !== "string") return {};

    const normalized = query.trim().toLowerCase().replace(/\s+/g, " ");

    const result = {
      raw: normalized,
      bedrooms: null,
      bathrooms: null,
      property_type: null,
      city: null,
      minPrice: null,
      maxPrice: null,
      listing_type: null,
      furnishing: null,
      features: [],
    };

    result.bedrooms = extractBedrooms(normalized);
    result.bathrooms = extractBathrooms(normalized);
    result.property_type = extractPropertyType(normalized);
    result.listing_type = extractListingType(normalized);
    result.furnishing = extractFurnishing(normalized);

    const priceResult = extractPriceRange(normalized);
    result.minPrice = priceResult.minPrice;
    result.maxPrice = priceResult.maxPrice;

    result.city = extractLocation(normalized, result.listing_type);
    result.features = extractFeatures(normalized);

    return result;
  },

  buildQueryParams(parsed) {
    const params = {};

    if (parsed.bedrooms) params.minBedrooms = parsed.bedrooms;
    if (parsed.bathrooms) params.minBathrooms = parsed.bathrooms;
    if (parsed.property_type) params.property_types = parsed.property_type;
    if (parsed.city) params.city = parsed.city;
    if (parsed.listing_type) params.listing_types = parsed.listing_type;
    if (parsed.furnishing) params.furnishing = parsed.furnishing;
    if (parsed.minPrice) params.minPrice = parsed.minPrice;
    if (parsed.maxPrice) params.maxPrice = parsed.maxPrice;
    if (parsed.features.length) params.amenities = parsed.features.join(",");

    return params;
  },
};

const BEDROOM_PATTERNS = [
  /(\d+)\s*[-]?\s*(?:bedroom|bed\s*room|bed|bdrm|beds|br|b\/r)\b/i,
  /(?:studio|self-contained)\b/i,
];

const BATHROOM_PATTERNS = [
  /(\d+)\s*[-]?\s*(?:bathroom|bath|baths|bathrm)\b/i,
];

const PROPERTY_TYPES = [
  { terms: ["apartment", "flat", "apt"], value: "Apartment" },
  { terms: ["house", "home", "detached"], value: "House" },
  { terms: ["duplex"], value: "Duplex" },
  { terms: ["bungalow"], value: "Bungalow" },
  { terms: ["land", "plot", "lot"], value: "Land" },
  { terms: ["studio"], value: "Studio" },
  { terms: ["mini.?flat", "mini.?apartment"], value: "Mini Flat" },
  { terms: ["terrace", "townhouse", "town.?house"], value: "Terrace" },
  { terms: ["mansion"], value: "Mansion" },
  { terms: ["villa"], value: "Villa" },
  { terms: ["penthouse"], value: "Penthouse" },
  { terms: ["warehouse"], value: "Warehouse" },
  { terms: ["office"], value: "Office" },
  { terms: ["shop", "store", "retail"], value: "Shop" },
  { terms: ["commercial"], value: "Commercial" },
];

const LISTING_TYPE_PATTERNS = [
  { pattern: /for\s+sale|buying|purchase/i, value: "sale" },
  { pattern: /for\s+rent|rental|renting|to\s+let|letting/i, value: "rent" },
  { pattern: /for\s+lease|leasehold|leasing/i, value: "lease" },
  { pattern: /short.?let|short.?stay|shortterm|short.?term/i, value: "shortlet" },
];

const FURNISHING_PATTERNS = [
  { pattern: /furnished/i, value: "furnished" },
  { pattern: /unfurnished/i, value: "unfurnished" },
  { pattern: /semi.?furnished|part.?furnished/i, value: "semi-furnished" },
];

const FEATURE_KEYWORDS = [
  { terms: ["parking", "car park", "garage"], value: "Parking" },
  { terms: ["pool", "swimming pool", "swimming"], value: "Swimming Pool" },
  { terms: ["garden", "yard", "compound"], value: "Garden" },
  { terms: ["generator", "gen", "power"], value: "Generator" },
  { terms: ["security", "gate", "fence", "cctv"], value: "Security" },
  { terms: ["gym", "fitness"], value: "Gym" },
  { terms: ["balcony"], value: "Balcony" },
  { terms: ["elevator", "lift"], value: "Elevator" },
  { terms: ["ac", "air.?con", "air.?condition", "air conditioning"], value: "AC" },
  { terms: ["bq", "boys.?quarters", "staff.?quarters", "servant"], value: "Staff Quarters" },
  { terms: ["internet", "wifi"], value: "Internet" },
  { terms: ["borehole", "well"], value: "Borehole" },
  { terms: ["prepaid.?meter"], value: "Prepaid Meter" },
  { terms: ["d\.s\.?s\.?b|dsb|satellite"], value: "DSTV" },
  { terms: ["wardrobe", "built.?in"], value: "Wardrobe" },
  { terms: ["tiled", "tiles", "marble", "granite"], value: "Tiled Floor" },
  { terms: ["pop", "ceiling"], value: "POP Ceiling" },
  { terms: ["kitchen.?cabinet", "modern.?kitchen"], value: "Modern Kitchen" },
];

const NIGERIAN_CITIES = [
  "lagos", "abuja", "port harcourt", "ph", "iba", "kaduna", "kano", "enugu",
  "owerri", "awka", "onitsha", "asaba", "benin", "warri", "effurun",
  "akure", "ondo", "adó-èkìtì", "ibadan", "ogbomosho", "osogbo",
  "ilorin", "abeokuta", "ijebu ode", "sagamu", "badagry", "epé",
  "ikeja", "lekki", "ajah", "vi", "victoria island", "ikoyi",
  "surulere", "yaba", "mushin", "oshodi", "maryland", "gbagada",
  "ogba", "ikeja", "magodo", "isheri", "abule egba", "festac",
  "amuwo odofin", "satellite town", "apapa", "banana island",
  "mainland", "island", "gwarinpa", "maitama", "asokoro", "wuse",
  "jabi", "kubwa", "lugbe", "nyanya", "katampe", "durumi",
  "garki", "gudu", "life camp", "guzape", "galadimawa",
  "trans ekulu", "new haven", "independence layout", "ogui",
  "abakpa", "emene", "achi", "nsukka",
  "g.r.a.", "gra", "new layout", "government reservation area",
  "elelenwo", "rivers", "trans amadi", "woji", "oha",
  "diobu", "mile", "rumuokwuta", "rumuola",
];

const LOCATION_TRIGGERS = [
  /in\s+([a-z\s\.\-]+?)(?:\s+(?:under|above|between|for|with|,|\||$))/i,
  /at\s+([a-z\s\.\-]+?)(?:\s+(?:under|above|between|for|with|,|\||$))/i,
  /near\s+([a-z\s\.\-]+?)(?:\s+(?:under|above|between|for|with|,|\||$))/i,
  /around\s+([a-z\s\.\-]+?)(?:\s+(?:under|above|between|for|with|,|\||$))/i,
];

function extractBedrooms(text) {
  const studioMatch = text.match(/\bstudio\b/i);
  if (studioMatch) return 0;

  for (const pattern of BEDROOM_PATTERNS) {
    const match = text.match(pattern);
    if (match && match[1]) return parseInt(match[1], 10);
  }

  if (/\bmini-flat\b|\bmini flat\b/i.test(text)) return 1;

  return null;
}

function extractBathrooms(text) {
  for (const pattern of BATHROOM_PATTERNS) {
    const match = text.match(pattern);
    if (match && match[1]) return parseInt(match[1], 10);
  }
  return null;
}

function extractPropertyType(text) {
  for (const pt of PROPERTY_TYPES) {
    for (const term of pt.terms) {
      const regex = new RegExp(`\\b${term}\\b`, "i");
      if (regex.test(text)) return pt.value;
    }
  }
  return null;
}

function extractListingType(text) {
  for (const lp of LISTING_TYPE_PATTERNS) {
    if (lp.pattern.test(text)) return lp.value;
  }
  return null;
}

function extractFurnishing(text) {
  for (const fp of FURNISHING_PATTERNS) {
    if (fp.pattern.test(text)) return fp.value;
  }
  return null;
}

function extractPriceRange(text) {
  let minPrice = null;
  let maxPrice = null;

  const betweenMatch = text.match(
    /between\s+(\d+(?:\.\d+)?)\s*(?:million|m|k|,)?\s*(?:and|\-|to)\s*(\d+(?:\.\d+)?)\s*(?:million|m|k)?/i
  );
  if (betweenMatch) {
    const [_, low, high] = betweenMatch;
    const lowNum = parseFloat(low);
    const highNum = parseFloat(high);

    const lowMultiplier = detectMultiplier(betweenMatch[0], low);
    const highMultiplier = detectMultiplier(betweenMatch[0], high);

    minPrice = lowNum * lowMultiplier;
    maxPrice = highNum * highMultiplier;
    return { minPrice, maxPrice };
  }

  const underMatch = text.match(
    /under\s+(\d+(?:\.\d+)?)\s*(?:million|m|k)?/i
  );
  if (underMatch) {
    const num = parseFloat(underMatch[1]);
    const multiplier = detectMultiplier(underMatch[0], underMatch[1]);
    maxPrice = num * multiplier;
  }

  const aboveMatch = text.match(
    /(?:above|over|from|minimum|min)\s+(\d+(?:\.\d+)?)\s*(?:million|m|k)?/i
  );
  if (aboveMatch) {
    const num = parseFloat(aboveMatch[1]);
    const multiplier = detectMultiplier(aboveMatch[0], aboveMatch[1]);
    minPrice = num * multiplier;
  }

  const barePriceMatch = text.match(
    /(?:under|above|between|for|at|with|,)\s*₦?\s*(\d+(?:\.\d+)?)\s*(?:million|m|k|,)?/i
  );
  if (barePriceMatch && !maxPrice && !minPrice) {
    const num = parseFloat(barePriceMatch[1]);
    const multiplier = detectMultiplier(barePriceMatch[0], barePriceMatch[1]);
    if (text.includes("under") || text.includes("below")) {
      maxPrice = num * multiplier;
    } else if (text.includes("above") || text.includes("over") || text.includes("from")) {
      minPrice = num * multiplier;
    }
  }

  return { minPrice, maxPrice };
}

function detectMultiplier(fullMatch, numStr) {
  if (new RegExp(`${numStr}\\s*million|${numStr}m\\b`, "i").test(fullMatch)) return 1000000;
  if (new RegExp(`${numStr}\\s*k|${numStr}k\\b`, "i").test(fullMatch)) return 1000;
  if (parseFloat(numStr) < 1000) return 1000000;
  return 1;
}

function extractLocation(text, listingType) {
  let bestMatch = null;

  for (const trigger of LOCATION_TRIGGERS) {
    const match = text.match(trigger);
    if (match && match[1]) {
      const location = match[1].trim()
        .replace(/[,\s]+$/, "")
        .replace(/^(?:the|a|an)\s+/i, "")
        .trim();
      if (location.length > 0) {
        bestMatch = location;
        break;
      }
    }
  }

  if (!bestMatch) {
    for (const city of NIGERIAN_CITIES) {
      const escaped = city.replace(/[.\-]/g, "\\$&");
      const regex = new RegExp(`\\b${escaped}\\b`, "i");
      if (regex.test(text)) {
        bestMatch = city;
        break;
      }
    }
  }

  if (bestMatch) {
    const cityMap = {
      "vi": "Victoria Island",
      "ph": "Port Harcourt",
      "g.r.a.": "GRA",
      "gra": "GRA",
    };
    const normalizedKey = bestMatch.toLowerCase();
    if (cityMap[normalizedKey]) return cityMap[normalizedKey];

    return bestMatch
      .split(/\s+/)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
  }

  return null;
}

function extractFeatures(text) {
  const found = [];
  for (const f of FEATURE_KEYWORDS) {
    for (const term of f.terms) {
      const regex = new RegExp(`\\b${term}\\b`, "i");
      if (regex.test(text)) {
        found.push(f.value);
        break;
      }
    }
  }
  return found;
}

export default nlpSearchService;
