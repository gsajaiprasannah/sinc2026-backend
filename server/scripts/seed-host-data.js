// One-off CLI wrapper — imports real host-member data from the SINC2026
// "Host members Record Sheet" Excel export into host_members, committees,
// committee_members, and the itinerary. The actual data + logic lives in
// server/seedHostData.js so the admin panel's "Import from Excel" button
// (POST /api/admin/seed-host-data) can call the exact same code.
//
// Usage (e.g. from the Render Shell): node server/scripts/seed-host-data.js
const { runSeed } = require('../seedHostData');

runSeed()
  .then((summary) => {
    console.log(`host_members: ${summary.membersInserted} inserted, ${summary.membersUpdated} updated`);
    console.log(`committees: ${summary.committeesCreated} created, ${summary.membershipsCreated} memberships created`);
    console.log(`itinerary: ${summary.itineraryResult}`);
    process.exit(0);
  })
  .catch((e) => { console.error(e); process.exit(1); });
