// What some objects do and the settings they take, from each object's own label in the game files and how the
// game's courses place them. `settings`: the object's Dynamic values (type int = whole number, float, bool).
// Where the exact effect is a best guess from how the game uses it, the text says so.

const ITEMBOX = {
  what: 'An item box: drive through it to get an item. It comes back after a moment.',
  scale: 'Leave at 1. Item boxes keep their normal size in the game\'s courses.',
  settings: [
    { key: 'IsUseDistanceCorrect', type: 'bool', def: false, hint: 'Every item box the game places has this off. Probably: when on, the items you get depend on how far behind the leader you are. Leave it off unless you want to experiment.' },
  ],
  tips: ['Put them about 1.6 m above the road (Quick Create and Add object do this for you).', 'A row of 3–5 across the road, every 200–300 m, is how the game spaces them.'],
};
const DASH = {
  what: 'A dash panel: karts that drive over it get a speed boost.',
  scale: 'Size it with Scale: every one in the game is scaled to fit its road. X is the width, Z the length.',
  settings: [],
  tips: ['Lay it flat on the road, facing the way karts drive (turn it with the Rotate tool).', 'The "E" kind is the one made for Rainbow Road\'s slot, which custom tracks use.'],
};
const GLIDE = {
  what: 'A glide ramp: karts that drive over it open their gliders.',
  scale: 'Size it with Scale, like a dash panel.',
  settings: [],
  tips: ['Put it at the edge of a jump, facing the gap.', 'Add a "Glide area (Bullet Bill)" over the gap so a Bullet Bill can cross it too.'],
};
const DOSSUN = {
  what: 'A Thwomp that slams down onto the road over and over.',
  scale: 'Size it with Scale: the game scales every one it places.',
  settings: [
    { key: 'WaitFrame', type: 'int', def: 300, unit: 'frames', hint: 'Probably the wait between slams, in frames (60 = 1 second). Rainbow Road uses 200, 300 and 360 (about 3.3 to 6 seconds). Different values on neighbouring Thwomps make them slam out of step.' },
  ],
  tips: ['Place it in the air above the road, where it should land: it slams down onto the ground below it.',
    'It only slams over stage ground. Tracks built by the Track Creator from v35 on have stage-ground roads; rebuild older tracks for Thwomps to work.',
    'In the game, normal Thwomps only appear on a few in-between routes, and the ones on Bowser\'s Castle are dropped by the Kamek item.'],
};

const INFO = {
  'CmnObj_ItemBox000_A_00': { title: 'Item box', ...ITEMBOX },
  'CmnObj_ItemBox000_B_00': { title: 'Double item box', ...ITEMBOX, what: 'A double item box: gives two items. Set up like a normal item box; the game uses about one of these for every four normal ones.' },
  'CmnObj_Coin000_A_00': {
    title: 'Coin', what: 'A coin: drive through it to collect it.',
    scale: 'Leave at 1.', settings: [],
    tips: ['The game lines coins up in rows or arcs along the racing line.', 'A track\'s coin count is updated for you when you build it.'],
  },
  'CmnObj_DashBoard000_E_00': { title: 'Dash panel', ...DASH },
  'CmnObj_GlideBoard000_E_00': { title: 'Glide ramp', ...GLIDE },
  'CmnObj_AccelRing000_A_00': {
    title: 'Boost ring', what: 'A star-shaped ring that boosts karts flying or driving through it.',
    scale: 'Size it with Scale.', settings: [],
    tips: ['Good in the air after a glide ramp, along the glide line.'],
  },
  'CmnObj_DossunStar000_A_00': { title: 'Star Thwomp', ...DOSSUN, what: 'Rainbow Road\'s star Thwomp: slams down onto the road over and over.' },
  'CmnObj_Dossun000_A_00': { title: 'Thwomp', ...DOSSUN },
  'SystemObj_HighSpeedArea_00': {
    title: 'High-speed area', what: 'An invisible box: karts inside it go faster.',
    scale: 'Scale the box to cover the stretch of road to speed up (X = width, Y = height, Z = length).',
    settings: [
      { key: 'SpeedRate', type: 'float', def: 1.4, hint: 'How much faster karts go inside the box: 1 = normal, 1.4 = 40% faster. Rainbow Road uses 1.4 in all 18 of its boxes.' },
    ],
    tips: ['Use it on long straights or downhill runs. Very high values make the track hard to drive.'],
  },
  'SystemObj_RescueArea_00': {
    title: 'Rescue area', what: 'An invisible box placed where you can fall off. Every course has several. Most likely Lakitu rescues karts that fall into it.',
    scale: 'Scale the box to cover the drop: under the track\'s edges, gaps and off-track pits.',
    settings: [],
    tips: ['Add these under your track\'s gaps and edges so karts that fall get put back.', 'Keep them below the road so they don\'t catch karts still on it.'],
  },
  'SystemObj_ValleyArea_00': {
    title: 'Valley area', what: 'An invisible box the game places over pits and drops. Its exact effect is unclear: probably it marks a drop for the CPUs or the camera.',
    scale: 'Scale it to cover the pit or drop.', settings: [],
    tips: ['If you add rescue areas, adding one of these over the same drops copies how the game does it.'],
  },
  'SystemObj_GlideAreaKiller_00': {
    title: 'Glide area (Bullet Bill)', what: 'An invisible box that lets a Bullet Bill fly across a gap instead of falling.',
    scale: 'Scale it to cover the gap, from the ramp to the landing.', settings: [],
    tips: ['Put one over every jump that karts normally glide across.'],
  },
  'Area_DeleteLinkedActor_00': {
    title: 'Remove-linked-objects area', what: 'An invisible box that removes the objects it is linked to. Rainbow Road links over 500 objects to these. Probably it hides free-roam-only things during races, or saves performance.',
    scale: 'Scale the box to cover the area it is meant for.', settings: [],
    links: 'Link it to each object it should remove: select the area, Shift-click the object, then click "Link 1st → 2nd". The links show as pink lines.',
    tips: ['You don\'t need these on a custom track unless you\'re copying Rainbow Road\'s scenery setup.'],
  },
  'CmnObj_EagleRainbow000_A_00': {
    title: 'Eagle (Rainbow Road)', what: 'An eagle that flies around along a path.',
    scale: 'The game scales each one.', settings: [],
    links: 'Link it to a point on a guide path (a "GuideGraphRail"): it flies along that path.',
    tips: [],
  },
  'StartPosition': {
    title: 'Start spot', what: 'Where one kart starts the race. A course has one per kart, plus one for Time Trials.',
    scale: 'Not used.',
    settings: [
      { key: 'StartPositionId', type: 'int', def: 1, hint: 'Which grid place this is: 1 to 23 (the first place has no number). Every number should be used once.' },
      { key: 'IsTimeAttack', type: 'bool', def: false, hint: 'On for the single spot used in Time Trials.' },
    ],
    tips: ['Quick Create\'s "Start grid" lays out and numbers all of these for you.', 'The cone points the way the kart faces.'],
  },
};

// generic notes for families of objects without their own entry
const FAMILIES = [
  [/^CmnObj_DashBoard\d+_/, { title: 'Dash panel', ...DASH }],
  [/^CmnObj_DashPlateRainbow\d+_/, { title: 'Dash panel (Rainbow Road)', ...DASH, tips: ['Rainbow Road\'s own dash panels, shaped for its sections. For your own track, "CmnObj_DashBoard000_E_00" is easier to fit.'] }],
  [/^CmnObj_GlideBoard\d+_/, { title: 'Glide ramp', ...GLIDE }],
  [/^CmnObj_RainbowGlidePlate\d+_/, { title: 'Glide ramp (Rainbow Road)', ...GLIDE }],
  [/^CmnObj_ItemBox\d+_/, { title: 'Item box', ...ITEMBOX }],
  [/^CmnObj_Coin\d+_/, { title: 'Coin', what: 'A coin.', scale: 'Leave at 1.', settings: [], tips: [] }],
];

export function objInfo(name) {
  if (!name) return null;
  if (INFO[name]) return INFO[name];
  for (const [re, info] of FAMILIES) if (re.test(name)) return info;
  return null;
}
