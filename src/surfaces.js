// Collision surface types for Mario Kart World (decoded from PhiveConfig + the
// World_Game03 static-compound tiles, checked against Mario Bros. Circuit).
//
// How a collision triangle gets its surface:
//   bphsc header u32[15] at 0x0C = section offsets.
//   section 4: 20-byte records {u16 instIdx, 0, u16 1024, u16, u16, u16, u16 matStart, 0, u16 matCount, 0}
//   section 5: material table, 16 bytes each {u32 material, u32 subMaterial, u64 userShapeTagMask}
//   section 6: collision-filter masks (same count as section 5)
//   hknpMeshShape.shapeTagTable: sorted (u32 primitiveKey, u16 shapeTag) runs; 65535 = end
//   primitiveKey = (sectionIndex << 9) | (primitiveIndex << 1) | (second triangle of quad ? 1 : 0)
//   material of a triangle = sec5[ sec4[instance.idx].matStart + shapeTag ]
//   Sections whose (sectionOffset + vertex) passes 2^31 wrap round as signed int32.

export const MATERIALS = ['Undefined','Vehicle','Object','Water','Road','LowDirt','Dirt','HighDirt','Slip','HighSlip',
  'Wall','LowWall','BoundWall','AirWall','Valley','Rescue','Dash','Gravity','Glide','Trampoline',
  'NoBoundNoFrictionObject','NoFrictionObject','HighBoundObject','Coin','ItemObj','Block','MuddyWater','Lava','Fall',
  'Shallows','Pole','Pull','Bumpy','Audience','HPWall','DashGlide','MobVehicleWall','KillerGlide'];

export const SUBMATERIALS = ['Undefined','Vehicle','Object','Water','Asphalt','Concrete','Stone','Wood','Kusa','Soil',
  'Sand','Snow','Ice','Iron','Kanaami','Glass','Carpet','Cloud','Rainbow','AirWall','Mud','Lava','GhostSwamp',
  'PetalViolet','PetalOrange','Leaf','Vinyl','Plastic','Biscuit','Candy','ChocoChip','FlowerRed','FlowerWhite','Bone'];

// userShapeTagMask bits (UserShapeTagMaskCollection)
export const TAGBITS = { Terrain:1, RoadSystem:2, Attach:32, DecalTrail:64, WallRideOff:128, Step:256, NoJA:512,
  LightOn:1024, LightOff:2048, SideReject:4096 };

const M = n => MATERIALS.indexOf(n), S = n => SUBMATERIALS.indexOf(n);

// Brushes for the track creator. Each paints one (material, subMaterial, mask) triple.
// "seen" = combinations that Mario Bros. Circuit itself uses.
export const BRUSHES = [
  { id:'road_asphalt',   label:'Road – asphalt',        mat:M('Road'),     sub:S('Asphalt'),  mask:0,   color:'#3a3a3a', seen:true },
  { id:'road_concrete',  label:'Road – concrete',       mat:M('Road'),     sub:S('Concrete'), mask:0,   color:'#8a8a8a', seen:true },
  { id:'road_iron',      label:'Road – metal/girder',   mat:M('Road'),     sub:S('Iron'),     mask:0,   color:'#5070a0', seen:true },
  { id:'road_wood',      label:'Road – wooden',         mat:M('Road'),     sub:S('Wood'),     mask:0,   color:'#b08040', seen:true },
  { id:'road_dirt',      label:'Road – dirt track',     mat:M('Road'),     sub:S('Soil'),     mask:0,   color:'#a08050', seen:true },
  { id:'kerb',           label:'Kerb / step',           mat:M('Road'),     sub:S('Undefined'),mask:TAGBITS.Step, color:'#ff4080', seen:true },
  { id:'offroad',        label:'Offroad – dirt',        mat:M('Dirt'),     sub:S('Soil'),     mask:0,   color:'#b07a3a', seen:true },
  { id:'grass',          label:'Offroad – grass',       mat:M('Dirt'),     sub:S('Kusa'),     mask:0,   color:'#5aa040' },
  { id:'light_offroad',  label:'Light offroad – grass', mat:M('LowDirt'),  sub:S('Kusa'),     mask:0,   color:'#88c060' },
  { id:'heavy_offroad',  label:'Heavy offroad',         mat:M('HighDirt'), sub:S('Soil'),     mask:0,   color:'#6b4b1a', seen:true },
  { id:'sand',           label:'Sand',                  mat:M('Dirt'),     sub:S('Sand'),     mask:0,   color:'#e0c890' },
  { id:'snow',           label:'Snow',                  mat:M('Dirt'),     sub:S('Snow'),     mask:0,   color:'#f0f4ff' },
  { id:'ice',            label:'Ice (slippery)',        mat:M('Slip'),     sub:S('Ice'),      mask:0,   color:'#a0e0ff' },
  { id:'bumpy',          label:'Bumpy (rumble)',        mat:M('Bumpy'),    sub:S('Wood'),     mask:0,   color:'#f0c000', seen:true },
  { id:'boost',          label:'Boost pad',             mat:M('Dash'),     sub:S('Undefined'),mask:0,   color:'#ff7f00' },
  { id:'glide',          label:'Glide ramp',            mat:M('Glide'),    sub:S('Undefined'),mask:0,   color:'#20d0a0', seen:true },
  { id:'water',          label:'Water',                 mat:M('Water'),    sub:S('Water'),    mask:0,   color:'#40b0ff' },
  { id:'shallows',       label:'Shallow water',         mat:M('Shallows'), sub:S('Water'),    mask:0,   color:'#80d0ff' },
  { id:'lava',           label:'Lava',                  mat:M('Lava'),     sub:S('Lava'),     mask:0,   color:'#ff3000' },
  { id:'fall',           label:'Fall-out zone',         mat:M('Fall'),     sub:S('Undefined'),mask:0,   color:'#000000' },
  { id:'wall_concrete',  label:'Wall – concrete/stone', mat:M('Wall'),     sub:S('Concrete'), mask:0,   color:'#d04040', seen:true },
  { id:'wall_iron',      label:'Wall – metal',          mat:M('Wall'),     sub:S('Iron'),     mask:0,   color:'#c03050', seen:true },
  { id:'wall_wood',      label:'Wall – wooden',         mat:M('Wall'),     sub:S('Wood'),     mask:0,   color:'#a05030', seen:true },
  { id:'pole_wood',      label:'Pole – wooden (trunks, posts)', mat:M('Pole'), sub:S('Wood'), mask:0, color:'#8a5a2b' },
  { id:'pole_iron',      label:'Pole – metal (lamp posts, rails)', mat:M('Pole'), sub:S('Iron'), mask:0, color:'#7a8aa0' },
  { id:'invisible_wall', label:'Invisible wall',        mat:M('AirWall'),  sub:S('AirWall'),  mask:0,   color:'#ff99ff', seen:true },
];

export const brushById = id => BRUSHES.find(b => b.id === id);
export const describe = (mat, sub, mask = 0) =>
  `${MATERIALS[mat] ?? mat}/${SUBMATERIALS[sub] ?? sub}` +
  Object.entries(TAGBITS).filter(([, v]) => mask & v).map(([k]) => ' +' + k).join('');
