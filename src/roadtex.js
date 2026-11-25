// Textures from the game's own courses for a road built from the centre line.
// Each is read from the player's dump when the track is built (and for the preview): nothing is bundled.
// size: how many metres one copy of the picture covers; 0 = stretched across the surface (road strips with
// their own edges and lines, kerb strips). The length along the road follows the picture's shape.
const C0 = 'CmnTex_Stage_';
export const SURFACES = [
  { key: 'road', label: 'Road', slot: 'asphalt' },
  { key: 'edge', label: 'Edge', slot: 'floorparts' },
  { key: 'wall', label: 'Wall', slot: 'frame' },
  { key: 'ground', label: 'Ground', slot: 'floortile' },
  { key: 'beach', label: 'Beach', slot: 'backside01', fit: 'g', def: C0 + 'DesertHills_SandDirt_00_Alb' },
  { key: 'rail', label: 'Rails', slot: 'backside00', fit: 'w', def: C0 + 'Lava_A_GalvanizedIron_00_Alb' },
  { key: 'cliff', label: 'Cliffs', slot: 'watersedge', fit: 'w', def: C0 + 'FirstCircuit_CliffWall_00_Alb' },
  { key: 'mushroom', label: 'Mushrooms', slot: 'floorlight', fit: 'w', def: C0 + 'DonkeyKong_SteelWall_00_Alb' },
];
// surfaces each picture suits (r road, e edge, w wall, g ground): the list shows those first
const C = 'CmnTex_Stage_';
export const ROADTEX = [
  { course: 'Mario Bros. Circuit', items: [
    { name: C + 'FirstCircuit_Asphalt_00_Alb', label: 'Asphalt with kerbs', size: 0, fit: 'r' },
    { name: 'Stage_FirstCircuit_A_Road_Asphalt_02_Bright_Alb', label: 'Asphalt, two lines', size: 0, fit: 'r' },
    { name: C + 'FirstCircuit_OffRoadArea_RoadCenter_00_Alb', label: 'Dirt track', size: 0, fit: 'r' },
    { name: C + 'FirstCircuit_OffRoadArea_RoadSide_00_Alb', label: 'Dirt track edge', size: 0, fit: 'e' },
    { name: C + 'FirstCircuit_OffRoadArea_Dirt_00_Alb', label: 'Dirt', size: 8, fit: 'eg' },
    { name: 'Stage_FirstCircuit_B_ConcreteCurb_00_Alb', label: 'Concrete kerb', size: 3, fit: 'ew' },
    { name: C + 'FirstCircuit_A_ConcreteGroundParts_00_Alb', label: 'Concrete slabs', size: 0, fit: 'ew' },
    { name: C + 'FirstCircuit_CliffWall_00_Alb', label: 'Rock wall', size: 6, fit: 'wg' },
    { name: C + 'FirstCircuit_MortarPaint_00_Alb', label: 'Painted plaster', size: 4, fit: 'wg' },
  ] },
  { course: 'Bowser\'s Castle', items: [
    { name: C + 'Lava_IronPlate_00_Alb', label: 'Cracked iron road', size: 0, fit: 'r' },
    { name: C + 'Lava_ConcreteFloor_00_Alb', label: 'Concrete floor', size: 8, fit: 'rg' },
    { name: C + 'Lava_A_Tile_00_Alb', label: 'Stone tiles', size: 6, fit: 'rgw' },
    { name: C + 'Lava_A_RoadRed_00_Alb', label: 'Red flame strip', size: 0, fit: 'e' },
    { name: C + 'Lava_A_RoadBlue_00_Alb', label: 'Blue flame strip', size: 0, fit: 'e' },
    { name: C + 'Lava_A_Border_00_Alb', label: 'Red/blue kerb', size: 0, fit: 'ew' },
    { name: C + 'Lava_A_RampartParts_00_Alb', label: 'Castle machinery', size: 6, fit: 'w' },
    { name: C + 'Lava_A_GalvanizedIron_00_Alb', label: 'Metal panels', size: 4, fit: 'wg' },
    { name: C + 'Lava_A_Concrete_00_Alb', label: 'Concrete', size: 6, fit: 'wg' },
    { name: C + 'Lava_ColdLava_00_Alb', label: 'Cooled lava rock', size: 10, fit: 'g' },
    { name: 'CmnTex_Special_Lava_Alb', label: 'Lava (looks only)', size: 12, fit: 'g' },
  ] },
  { course: 'Rainbow Road', items: [
    { name: C + 'RainbowRoad_MainRoad00_Alb', label: 'Rainbow road', size: 10, fit: 'r' },
    { name: C + 'RainbowRoad_A_SS_RoadRunway_Alb', label: 'Space station runway', size: 0, fit: 'r' },
    { name: C + 'RainbowRoad_SS_RoadMetalRunway00_Alb', label: 'Metal runway', size: 0, fit: 'r' },
    { name: C + 'RainbowRoad_SI_CobbleRoad_00_Alb', label: 'Sky island cobbles', size: 0, fit: 'r' },
    { name: C + 'RainbowRoad_A_SS_EdgeChecker00_Alb', label: 'Chequered edge', size: 0, fit: 'e' },
    { name: C + 'RainbowRoad_EdgeCover_00_Alb', label: 'Starry edge', size: 4, fit: 'ew' },
    { name: C + 'RainbowRoad_A_EdgeMainRoad_Alb', label: 'Gold trim', size: 0, fit: 'ew' },
    { name: C + 'RainbowRoad_A_Fence_01_Alb', label: 'Gold fence art', size: 0, fit: 'w' },
    { name: C + 'RainbowRoad_SS_WallA_Alb', label: 'Station wall', size: 0, fit: 'w' },
    { name: C + 'RainbowRoad_SS_WhitePanel00_Alb', label: 'White panels', size: 4, fit: 'wg' },
    { name: C + 'RainbowRoad_CliffWhite_00_Alb', label: 'Cloud rock', size: 8, fit: 'wg' },
    { name: C + 'RainbowRoad_SI_Grass_00_Alb', label: 'Sky island grass', size: 10, fit: 'g' },
  ] },
  { course: 'Desert Hills', items: [
    { name: C + 'DesertHills_SandRoad_00_Alb', label: 'Sand road', size: 8, fit: 'r' },
    { name: C + 'DesertHills_SandRoad_01_Alb', label: 'Sand road (lighter)', size: 8, fit: 'rg' },
    { name: C + 'DesertHills_CobbleStone_01_Alb', label: 'Sandstone paving', size: 8, fit: 'r' },
    { name: C + 'DesertHills_Floor_00_Alb', label: 'Stone floor', size: 6, fit: 'rg' },
    { name: C + 'DesertHills_Wood_Bridge_Alb', label: 'Wooden bridge', size: 0, fit: 'r' },
    { name: C + 'DesertHills_RoadSide_00_Alb', label: 'Road edge', size: 0, fit: 'e' },
    { name: C + 'DesertHills_SandDirt_00_Alb', label: 'Sand', size: 10, fit: 'eg' },
    { name: C + 'DesertHills_Grass_00_Alb', label: 'Grass', size: 10, fit: 'eg' },
    { name: C + 'DesertHills_Ruin_RuinWall_Alb', label: 'Ruin wall', size: 4, fit: 'w' },
    { name: C + 'DesertHills_Wall_00_Alb', label: 'Stone wall', size: 4, fit: 'w' },
    { name: C + 'DesertHills_Cliff_00_Alb', label: 'Cliff', size: 10, fit: 'wg' },
  ] },
  { course: 'DK Spaceport', items: [
    { name: C + 'DonkeyKong_PanelRoad_00_Alb', label: 'Blue road', size: 0, fit: 'r' },
    { name: C + 'DonkeyKong_PanelRoad_01_Alb', label: 'Blue road, centre line', size: 0, fit: 'r' },
    { name: C + 'DonkeyKong_Asphalt_01_Alb', label: 'Blue asphalt', size: 8, fit: 'rg' },
    { name: C + 'DonkeyKong_TrussRoad_00_Alb', label: 'Truss bridge', size: 0, fit: 'r' },
    { name: C + 'DonkeyKong_IronPlateRoad_00_Alb', label: 'Iron plates', size: 6, fit: 'rg' },
    { name: C + 'DonkeyKong_Asphalt_03_Alb', label: 'Blue edge strip', size: 0, fit: 'e' },
    { name: C + 'DonkeyKong_RoadEdge_00_Alb', label: 'Orange edge', size: 0, fit: 'e' },
    { name: C + 'DonkeyKong_StepLine_00_Alb', label: 'Yellow lines', size: 0, fit: 'e' },
    { name: C + 'DonkeyKong_CheckeredPlate_00_Alb', label: 'Chequer plate', size: 2, fit: 'eg' },
    { name: C + 'DonkeyKong_SteelWall_00_Alb', label: 'Red steel wall', size: 0, fit: 'w' },
    { name: C + 'DonkeyKong_WallPanel_00_Alb', label: 'Wall panels', size: 4, fit: 'w' },
    { name: C + 'DonkeyKong_MetalPanel_00_Alb', label: 'Metal panels', size: 4, fit: 'wg' },
    { name: C + 'DonkeyKong_Concrete_00_Alb', label: 'Concrete', size: 6, fit: 'g' },
  ] },
];
export const ALL_TEX = ROADTEX.flatMap(g => g.items.map(t => ({ ...t, course: g.course })));
export const texByName = n => ALL_TEX.find(t => t.name === n);
// the default (the base model's own look) and how big one copy is, per surface
export const DEFAULT_SIZE = { road: 4, edge: 4, wall: 4, ground: 10, beach: 10, rail: 2, cliff: 6, mushroom: 0 };

// the 30 stages on the VS / Time Trials course map, in the game's order, with their course names
export const VS_STAGES = [['FirstCircuit', 'Mario Bros. Circuit'], ['WestCity', 'Crown City'], ['Coaster', 'Whistlestop Summit'], ['DonkeyKong', 'DK Spaceport'],
  ['DesertHills_00', 'Desert Hills'], ['ShyGuyBazaar_00', 'Shy Guy Bazaar'], ['WarioStadium', 'Wario Stadium'], ['AirshipFortress_00', 'Airship Fortress'],
  ['DKPass_00', 'DK Pass'], ['SnowMountain_00', 'Starview Peak'], ['IceBuildings_00', 'Sky-High Sundae'], ['WarioShipyard_00', 'Wario Shipyard'],
  ['KoopaTroopaBeach_00', 'Koopa Troopa Beach'], ['DKJungleParkway_00', 'Faraway Oasis'], ['PeachBeach_00', 'Peach Beach'], ['LagoonCity_00', 'Salty Salty Speedway'],
  ['DinoDinoJungle_00', 'Dino Dino Jungle'], ['StormClouds_00', 'Great ? Block Ruins'], ['RaftingRiver_00', 'Cheep Cheep Falls'], ['Cave_00', 'Dandelion Depths'],
  ['Cinema_00', 'Boo Cinema'], ['DinoBones_00', 'Dry Bones Burnout'], ['MooMooFarm_00', 'Moo Moo Meadows'], ['ChocoMountain_00', 'Choco Mountain'],
  ['ToadFactory_00', 'Toad\'s Factory'], ['Lava_00', 'Bowser\'s Castle'], ['BigTree_00', 'Acorn Heights'], ['SFCMarioCircuit_00', 'Mario Circuit'],
  ['Central_00', 'Peach Stadium'], ['Rainbow_00', 'Rainbow Road']];
