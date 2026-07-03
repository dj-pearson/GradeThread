// US-1570: GradeThread MeasureCard v1 — canonical geometry constants.
//
// GENERATED from assets/measure-card/geometry-v1.json (the output of
// scripts/generate-measure-card.py, which also validates that the artwork
// DECODES with OpenCV ArUco before it is committed). Do not hand-edit values:
// a drift test in each stack compares this module against the JSON.
//
// The card: four ArUco DICT_5X5_1000 fiducials whose CENTERS form an exact
// 6in x 4in rectangle — those four known distances are the scale +
// homography ground truth for photo measurement. The marker ID SET is the
// card version: a future v2 uses NEW ids (never re-use these with changed
// geometry), so the calibration service can identify any card ever shipped.
// Mirrored web <-> edge (shared-constants convention): keep both copies
// byte-identical below this line.

export interface MeasureCardGeometry {
  version: number;
  dictionary: string;
  cardInches: { w: number; h: number };
  markerSizeInches: number;
  quietZoneInches: number;
  centerRectInches: { w: number; h: number };
  /** Marker ids in TL, TR, BR, BL order (clockwise from top-left). */
  markerIds: number[];
  /** Marker centers in card coordinates (inches, origin top-left). */
  markerCentersInches: Record<string, [number, number]>;
  /** 5x5 inner modules, row-major, 1 = white module (a 1-module black border surrounds them). */
  markerBits: Record<string, number[][]>;
}

export const MEASURE_CARD_V1: MeasureCardGeometry = {
  "version": 1,
  "dictionary": "DICT_5X5_1000",
  "cardInches": {
    "w": 7.5,
    "h": 5.5
  },
  "markerSizeInches": 1,
  "quietZoneInches": 0.25,
  "centerRectInches": {
    "w": 6,
    "h": 4
  },
  "markerIds": [
    10,
    11,
    12,
    13
  ],
  "markerCentersInches": {
    "10": [
      0.75,
      0.75
    ],
    "11": [
      6.75,
      0.75
    ],
    "12": [
      6.75,
      4.75
    ],
    "13": [
      0.75,
      4.75
    ]
  },
  "markerBits": {
    "10": [
      [
        1,
        0,
        0,
        1,
        1
      ],
      [
        1,
        1,
        0,
        0,
        1
      ],
      [
        1,
        1,
        0,
        1,
        1
      ],
      [
        1,
        0,
        0,
        0,
        0
      ],
      [
        0,
        0,
        0,
        1,
        1
      ]
    ],
    "11": [
      [
        1,
        1,
        0,
        1,
        0
      ],
      [
        0,
        0,
        1,
        0,
        1
      ],
      [
        1,
        0,
        1,
        1,
        0
      ],
      [
        1,
        0,
        1,
        1,
        0
      ],
      [
        0,
        0,
        0,
        0,
        0
      ]
    ],
    "12": [
      [
        1,
        1,
        1,
        1,
        0
      ],
      [
        0,
        1,
        1,
        0,
        0
      ],
      [
        0,
        1,
        0,
        1,
        0
      ],
      [
        1,
        1,
        0,
        0,
        0
      ],
      [
        1,
        0,
        0,
        0,
        1
      ]
    ],
    "13": [
      [
        0,
        0,
        1,
        0,
        1
      ],
      [
        1,
        1,
        1,
        0,
        0
      ],
      [
        1,
        1,
        1,
        0,
        0
      ],
      [
        0,
        1,
        0,
        1,
        1
      ],
      [
        0,
        0,
        1,
        1,
        0
      ]
    ]
  }
};

/** Every card version the calibration service can identify, newest first. */
export const MEASURE_CARD_VERSIONS: MeasureCardGeometry[] = [MEASURE_CARD_V1];

/** Resolve a card version from a set of detected marker ids (all four must match). */
export function cardVersionForIds(ids: number[]): MeasureCardGeometry | null {
  const set = new Set(ids);
  for (const card of MEASURE_CARD_VERSIONS) {
    if (card.markerIds.every((id) => set.has(id))) return card;
  }
  return null;
}
