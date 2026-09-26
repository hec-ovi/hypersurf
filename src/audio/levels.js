// Special levels as data. A level preset is a profile buildSongMap applies
// on top of the normal analysis: the same features, read differently. Pure
// (no DOM), so the worker, the menu and the tests share it.
//
//   speed      m/s range and how it swings: `density` is the share of the
//              drive taken from the local block density (ranked against the
//              song's own, so even a steady song swings), the rest from
//              intensity; `window` (s) is the density window, `smooth` (s)
//              the zero-phase smoothing, `curve` the drive exponent and
//              `pitchRate` (degrees per second) how fast the slope follows
//   maxRate    block cap per second at Mono (scaled by the mode's own cap)
//   onsetDelta peak-picking threshold for the blocks' onsets (the analysis
//              uses 0.07; lower keeps quieter notes)
//   greyFraction  share of the weakest blocks that turn grey
//   features   big moments: `gap` (s) kept between any two, `notBefore`
//              (s after the music starts), `novelty` for the song's own
//              section changes, `flipBars` / `maxFlips`, then `cycle`,
//              the shapes (LOOP names in lower case) that fill every
//              stretch left, each on the best bar line within `window`
//              seconds of the earliest one it fits
//   intro      the music starts where the intensity first reaches `level`
//              (snapped to the nearest beat): no blocks or moments before
//              it, and the run begins LEAD_IN seconds before it
//   palette    'rainbow': the track colour runs through the rainbow along
//              the track, every `rainbowLength` metres
//   vehicle    the vehicle the level rides by default

export const LEVEL_PRESETS = Object.freeze({
  nyan: Object.freeze({
    speed: Object.freeze({ min: 30, max: 122, density: 0.65, window: 3.4, smooth: 0.6, curve: 1.1, pitchRate: 26 }),
    maxRate: 9.5,
    onsetDelta: 0.025,
    greyFraction: 0.15,
    features: Object.freeze({
      gap: 1.6,
      notBefore: 3,
      novelty: 2,
      flipBars: 2,
      maxFlips: 99,
      window: 1.9,
      cycle: Object.freeze(['corkscrew', 'twist', 'double', 'flip', 'twist', 'plain']),
    }),
    intro: Object.freeze({ level: 0.7 }),
    palette: 'rainbow',
    rainbowLength: 360,
    vehicle: 'nyan',
  }),
});

/** The preset for a level id; throws on an unknown one. */
export function levelPreset(id) {
  const p = Object.prototype.hasOwnProperty.call(LEVEL_PRESETS, id) ? LEVEL_PRESETS[id] : null;
  if (!p) throw new Error(`unknown level ${id}`);
  return p;
}
