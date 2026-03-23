// modules/flexpolyline.js — HERE Flexible Polyline decoder
// Ref: https://github.com/heremaps/flexible-polyline
// Minimal, self-contained implementation (decode only).

const DECODING_TABLE = [
  62, -1, -1, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, -1, -1, -1, -1, -1, -1, -1,
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
  22, 23, 24, 25, -1, -1, -1, -1, 63, -1, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35,
  36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51
];

function _decodeChar(char) {
  if (char === undefined) return -1;
  const code = char.charCodeAt(0);
  return DECODING_TABLE[code - 45] ?? -1;
}

function _decodeUnsigned(encoded, index) {
  let result = 0;
  let shift = 0;
  let c;
  do {
    if (index >= encoded.length) break;
    c = _decodeChar(encoded[index++]);
    result |= (c & 0x1F) << shift;
    shift += 5;
  } while (c >= 0x20);
  return { value: result, nextIndex: index };
}

function _decodeSigned(encoded, index) {
  const { value, nextIndex } = _decodeUnsigned(encoded, index);
  return {
    value: (value & 1) ? ~(value >> 1) : (value >> 1),
    nextIndex
  };
}

/**
 * Decode a HERE Flexible Polyline string.
 * Ref format: version (unsigned) → header (unsigned) → delta-encoded coords
 * @param {string} encoded
 * @returns {{ coordinates: [number, number][], precision: number, thirdDim: number, thirdDimPrecision: number }}
 */
export function decode(encoded) {
  let index = 0;

  // 1. Version byte (must be 1)
  const { value: version, nextIndex: i0 } = _decodeUnsigned(encoded, index);
  index = i0;
  if (version !== 1) {
    throw new Error('Unsupported flexible polyline version: ' + version);
  }

  // 2. Header (precision + thirdDim + thirdDimPrecision)
  const { value: header, nextIndex: i1 } = _decodeUnsigned(encoded, index);
  index = i1;

  const precision         = header & 0x0F;
  const thirdDim          = (header >> 4) & 0x07;
  const thirdDimPrecision = (header >> 7) & 0x0F;
  const hasThirdDim       = thirdDim !== 0;

  const factor   = Math.pow(10, precision);
  const factor3d = Math.pow(10, thirdDimPrecision);

  const coordinates = [];
  let lat = 0, lng = 0, z = 0;

  while (index < encoded.length) {
    const dLat = _decodeSigned(encoded, index);
    index = dLat.nextIndex;
    lat += dLat.value;

    const dLng = _decodeSigned(encoded, index);
    index = dLng.nextIndex;
    lng += dLng.value;

    if (hasThirdDim) {
      const dZ = _decodeSigned(encoded, index);
      index = dZ.nextIndex;
      z += dZ.value;
    }

    coordinates.push([lat / factor, lng / factor]);
  }

  return { coordinates, precision, thirdDim, thirdDimPrecision };
}

/**
 * Convert a decoded polyline to a GeoJSON LineString.
 * @param {string} encoded  — flexible polyline string
 * @returns {{ type: 'LineString', coordinates: [number, number][] }}  — [lng, lat] order per GeoJSON spec
 */
export function toGeoJSON(encoded) {
  const { coordinates } = decode(encoded);
  return {
    type: 'LineString',
    coordinates: coordinates.map(([lat, lng]) => [lng, lat]),
  };
}
