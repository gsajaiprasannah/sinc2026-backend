// Occupancy of a registration — how many delegates it may hold.
//
// 'double' was split into 'double_king' and 'double_twin' (same two people,
// different bed configuration, which the hotel needs to know). Every place
// that used to compare reg_type === 'double' must go through these helpers
// instead, or a twin booking would silently be treated as single-occupancy:
// the capacity check would reject its second delegate, and the dashboard
// headcount would under-count the congress.
const DOUBLE_TYPES = ['double', 'double_king', 'double_twin'];

function isDoubleOccupancy(regType) {
  return DOUBLE_TYPES.includes(regType);
}
// How many delegates this registration may hold.
function occupancyOf(regType) {
  return isDoubleOccupancy(regType) ? 2 : 1;
}
// For use inside SQL, e.g. WHERE reg_type IN ('double','double_king',...).
const DOUBLE_TYPES_SQL = DOUBLE_TYPES.map((t) => `'${t}'`).join(',');

const REG_TYPE_LABEL = {
  single: 'Single',
  double: 'Double',
  double_king: 'Double King',
  double_twin: 'Double Twin',
  congress_only: 'Congress Only',
};

module.exports = { DOUBLE_TYPES, DOUBLE_TYPES_SQL, isDoubleOccupancy, occupancyOf, REG_TYPE_LABEL };
