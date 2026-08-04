#!/usr/bin/env node
/**
 * backfill-delegate-gstin.js — writes delegate GSTINs collected from the
 * registration spreadsheets into participants.gstin.
 *
 * Sources merged (4 Aug 2026):
 *   Delegates List.xlsx, Regi_SKAL Cong 2026 (details).xlsx,
 *   Skal Registration - 03 PERSONS (01 August 2026).xlsx
 *
 * Only GSTINs that pass the official checksum are included. 20
 * more were present in the sheets but are malformed and must be corrected by
 * hand rather than guessed at — a wrong GSTIN on a filed return is worse than
 * a blank one. They are listed at the foot of this file.
 *
 * Matched on the last 10 digits of phone or WhatsApp, which is how the
 * spreadsheets and the delegate table reliably line up. Never overwrites a
 * GSTIN already on a record.
 *
 * USAGE
 *   node server/scripts/backfill-delegate-gstin.js            # preview
 *   node server/scripts/backfill-delegate-gstin.js --apply    # commit
 *   node server/scripts/backfill-delegate-gstin.js --revert   # undo
 */

const db = require('../db');
const { validateGstin } = require('../lib/gst');

const APPLY = process.argv.includes('--apply');
const REVERT = process.argv.includes('--revert');
const BACKUP = 'participants_gstin_backup';

// [ last-10-digits-of-phone, GSTIN ]
const MAP = [
  ['6382132034', '33AAACD1219K2Z1'],            // Ganesh Kannan
  ['7006655272', '01BFPPS4706G1ZG'],            // Shaqoor Ahmad Sheikh
  ['7008134870', '21AAGCV8370D1ZG'],            // Amar Kumar Dash
  ['7353311234', '29APNPA4288A1ZX'],            // Abhinandan M P
  ['7414001100', '08AAFCR0675Q1ZQ'],            // Rajendra Ms. Pooja Bhatnagar
  ['7483142567', '29AACCR7212E1ZJ'],            // RAMESH BABU BABU
  ['8283847589', '27AACCK2338N1ZA'],            // AMARJIT
  ['8374566600', '36AALFV2899R1ZV'],            // HARI KISHAN D
  ['8420044050', '19ACQPA8488A1ZC'],            // Jay
  ['8527833865', '01ATZPB1072B1Z8'],            // Billal Bhat
  ['8754450825', '33AAHCG5701A1ZA'],            // GAYATHRI
  ['8793097097', '27BBGPN7516Q1ZX'],            // SAVITA
  ['8884328262', '29AAQPH0317K1ZJ'],            // Harish Shah
  ['9003118447', '33AABAT3592J1ZB'],            // VATSALA DEVDAS
  ['9004389283', '27AOPPS9161R1ZM'],            // Deepan
  ['9007478350', '19AACCW3908N1ZT'],            // June
  ['9011061121', '33AABAT3592J1ZB'],            // SIVAKUMAR DIVADKAR
  ['9022929018', '27AAAPB9837G1ZR'],            // MUKESH Fizardo
  ['9049998003', '27ALZPK7317C1ZR'],            // Dipesh KHATRI
  ['9163235870', '19ACQPA8488A1ZC'],            // Jay Agarwal
  ['9246800245', '32AADCM3357Q1Z5'],            // Dinesh
  ['9337123999', '21AAFCK0211M1Z1'],            // DEBASISH
  ['9372020385', '27AAJCR8494B1Z0'],            // Lalit Londhe
  ['9373177400', '27AAIFE2205M1ZG'],            // Manish Sushilkumar
  ['9388353664', '32AACCR7529L1Z5'],            // Raja Gopal
  ['9398285349', '36AAGFU7749E1ZT'],            // RAVI
  ['9415024598', '09AAACC9677L1ZY'],            // Sunil Bahadur
  ['9419018982', '01AABCM5918P1ZB'],            // MOHMAD AKRAM SHANGLOO
  ['9419079127', '01AABPQ2167K1ZV'],            // Zahoor
  ['9443305678', '33AABCG4766H1ZN'],            // Jamal Mohamed
  ['9444009654', '33AAMCP2812J1ZF'],            // Shankar
  ['9444012320', '33AAIPP1159P1ZA'],            // Pawan Kumar Gupta
  ['9444126234', '33AAACK9254B1ZV'],            // HEMA THIAGARAJAN
  ['9444226739', '33AABAT3592J1ZB'],            // KAMLESHWARAN J
  ['9444406604', '33AABAT3592J1ZB'],            // Aruna
  ['9448119224', '29BCMPS4480H1ZY'],            // Margaret Cherian
  ['9448496170', '29AAECB2113J1ZW'],            // DN Raju
  ['9535553555', '33AABCG8996R1ZM'],            // Ravindren N Gowda , Propreitor , TravelM
  ['9632539999', '29AAGFR0065C1ZG'],            // SUNDAR Rajkumar
  ['9655220000', '34AAECT9952D1Z7'],            // Amitava VK
  ['9666632888', '36BEQPA3959D2ZE'],            // Anil Kolla
  ['9673990102', '27CXEPK7796Q1ZA'],            // Hrishikesh kanade
  ['9677226795', '33AABCC8533C1Z4'],            // Arulmony Syed Hussain Mohideen
  ['9702354459', '21ATDPS1628N1ZK'],            // Anurag Nayak
  ['9747007479', '32AAFCG5655F2ZQ'],            // Sam
  ['9763720450', '27AAECJ0878J1Z8'],            // Prasad
  ['9765393820', '27AUAPB6693C1ZU'],            // RAJENDRA
  ['9778062483', '21AZRPK9305J1Z4'],            // RAHUL
  ['9796120000', '01ATBPB2760Q1ZW'],            // Mohd mohsin
  ['9797322000', '01CCGPS0206J1Z0'],            // MOHAMAD FAISAL NARWARI
  ['9797722244', '01CCGPS0206J1Z0'],            // MOHAMAD FAISAL
  ['9811230099', '07AAPFC1572J1Z7'],            // Siddharth Jain
  ['9819231973', '27ASNPS6368L1ZP'],            // Mamata
  ['9820025886', '27AALPG1452D1Z2'],            // SURESH GULRAJANI
  ['9820077107', '27AAACA4897J1ZA'],            // Maneka
  ['9820165612', '27AIHPG5582E1Z8'],            // Satyaprakash Gupta
  ['9820218210', '27AALFT9656J1ZB'],            // Arvind Tandon
  ['9820354101', '27AAACR4057P1ZX'],            // Vaibhav
  ['9821027983', '27AABCC5456E1ZT'],            // V.S. ABDULKAREEM
  ['9822030908', '27AACCE7027N1ZC'],            // Mehboob Gopalan
  ['9823021337', '27AAQPR3055C1ZL'],            // SHAHBEHRAM RABBANI
  ['9830431484', '19AANCS0983L1ZL'],            // Sandeep Kumar Sett
  ['9830960004', '19AAECA8796N1ZP'],            // Sanjeev Mehra
  ['9840029446', '33AABAT3592J1ZB'],            // PARAMESWARAN
  ['9840037711', '33AACCB2820J1Z3'],            // Kannappan
  ['9840047077', '33AABCC1990M1ZK'],            // S N
  ['9840077988', '33AABAT3592J1ZB'],            // Aruna Anandaveloo
  ['9840441200', '33AHTPR7866D1ZQ'],            // FATHIMA BAI
  ['9841018266', '33ASCPK7804Q2ZD'],            // Premnath KHAN
  ['9841044207', '33AADCP4820B1Z1'],            // Veerakumar
  ['9841067873', '33AAACC3027G1ZA'],            // BASKAR
  ['9841902302', '33AAGCG4079C1ZU'],            // Lawrence Rosario
  ['9844092150', '29AACCB3797N1ZY'],            // ROHIT
  ['9844329950', '29AAKAS8612B1ZE'],            // Balan Balakrishnan
  ['9845048836', '29AABFF1399L2ZY'],            // RANJINI SMITH
  ['9845066469', '29BCMPS4480H1ZY'],            // Jitendra
  ['9845080597', '29ACLPD2723J2ZJ'],            // WILLIAM ANTONY
  ['9845095098', '29AAACF8398K1ZV'],            // Govind
  ['9845449570', '29AAFCA7289R1ZL'],            // Badiger
  ['9845865485', '29AAWFT3387M1ZY'],            // Samarth
  ['9850545349', '27AAICD3388H1ZC'],            // Dilip
  ['9867564471', '27AASFV0549D1ZX'],            // HARSHAD SANTOSH THORAT
  ['9873707679', '06AABPB9828N1ZG'],            // PARAMJIT
  ['9873991873', '27ALJPB2792G1Z3'],            // Vishnu Ruby
  ['9874623332', '19AABCG1716F1ZX'],            // Maanav
  ['9880299969', '29AAYFM7647K1Z4'],            // KRISHNAMURTHY KRISHNAMURTHY
  ['9884061506', '33AABAT3592J1ZB'],            // SUBRAMANIAM SUBRAMANIAM
  ['9884111430', '33AEFPJ4108P1ZG'],            // JEYASEKARAN SHANTHAKUMAR
  ['9886030105', '29AABCG4059M1Z7'],            // Suresh Charles
  ['9886326567', '29AFFPG0131C1Z6'],            // Anurag
  ['9893574731', '23AACCT3376M1Z3'],            // MAHENDRA PRATAP SINGH
  ['9906036313', '24AANCB3653L1ZE'],            // VIKAS SHARMA
  ['9906560777', '01ACPPW5952J2Z1'],            // Asif Manzoor
  ['9910493247', '07AABCF8168Q1ZW'],            // Santosh
  ['9920025886', '27AALPG1452D1Z2'],            // Suresh
  ['9935500551', '09AAHCM7204Q2ZV'],            // AHMAD
  ['9941114041', '33AABAT3592J1ZB'],            // Geetha
  ['9986003600', '29AAFFW0299J1ZL'],            // jagmohan BHUTADA
  ['9989986969', '36AACCP5283H1Z9'],            // Bala Koteswara Rao
  ['9999065666', '07AAJFO2730N1ZZ'],            // Sandeep
];

async function revert() {
  const ex = await db.get('SELECT to_regclass($1) t', [BACKUP]);
  if (!ex || !ex.t) { console.error('No backup table — nothing to revert.'); process.exit(1); }
  const n = await db.transaction(async (tx) => {
    const r = await tx.run(`UPDATE participants p SET gstin = b.gstin FROM ${BACKUP} b WHERE p.id = b.id`);
    return r.rowCount;
  });
  console.log(`Reverted gstin on ${n} delegate(s).`);
}

async function main() {
  if (REVERT) return revert();

  const rows = await db.all(`
    SELECT id, name, gstin,
           RIGHT(regexp_replace(COALESCE(phone,''), '[^0-9]', '', 'g'), 10)    AS ph,
           RIGHT(regexp_replace(COALESCE(whatsapp,''), '[^0-9]', '', 'g'), 10) AS wa
      FROM participants
  `);
  const byPhone = new Map();
  for (const r of rows) {
    if (r.ph) byPhone.set(r.ph, r);
    if (r.wa && !byPhone.has(r.wa)) byPhone.set(r.wa, r);
  }

  const changes = [], already = [], unmatched = [];
  for (const [phone, gstin] of MAP) {
    const hit = byPhone.get(phone);
    if (!hit) { unmatched.push([phone, gstin]); continue; }
    if (hit.gstin && hit.gstin.trim()) { already.push(hit.name); continue; }
    const v = validateGstin(gstin, null);
    if (!v.valid) { console.log('  skipping malformed:', gstin); continue; }
    changes.push({ id: hit.id, name: hit.name, gstin, state: v.state });
  }

  console.log(`${MAP.length} GSTINs in the sheets.`);
  console.log(`  ${changes.length} delegate(s) would be updated`);
  console.log(`  ${already.length} already have one on file (left alone)`);
  console.log(`  ${unmatched.length} could not be matched to any delegate by phone\n`);

  if (changes.length) {
    console.log('id     delegate                       GSTIN             state');
    console.log('-'.repeat(78));
    changes.forEach((c) => console.log(
      `${String(c.id).padEnd(6)} ${String(c.name).slice(0, 29).padEnd(30)} ${c.gstin.padEnd(17)} ${c.state || ''}`));
    console.log('-'.repeat(78));
  }
  // Out-of-state customers are charged IGST rather than CGST+SGST, so the
  // spread matters for whoever files the return.
  const tn = changes.filter((c) => c.gstin.startsWith('33')).length;
  console.log(`place of supply: ${tn} Tamil Nadu (CGST+SGST), ${changes.length - tn} other states (IGST)`);

  if (!changes.length) { console.log('\nNothing to do.'); return; }
  if (!APPLY) { console.log('\nDRY RUN — nothing written. Re-run with --apply.'); return; }

  await db.transaction(async (tx) => {
    await tx.run(`DROP TABLE IF EXISTS ${BACKUP}`);
    await tx.run(`CREATE TABLE ${BACKUP} AS SELECT id, gstin, NOW() AS backed_up_at
                    FROM participants WHERE id = ANY($1::int[])`, [changes.map((c) => c.id)]);
    for (const c of changes) await tx.run('UPDATE participants SET gstin=$1 WHERE id=$2', [c.gstin, c.id]);
  });
  console.log(`\nApplied to ${changes.length} delegate(s). Previous values in ${BACKUP}.`);
  console.log('To undo:  node server/scripts/backfill-delegate-gstin.js --revert');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

// --- Malformed GSTINs found in the sheets, NOT applied ---------------------
// These fail the GST checksum. Correct them on the record by hand.
//   9831031036   ABCD124589           Test
//   9596778899   AAPCS2982P1ZP        Shamim Ahmed
//   9987211811   27AAACH92121ZC       ANIL MADHAV HARIBAL
//   1234567890   123456798            Test
//   9820680203   27AIQPP1567K         Irshad
//   9885694258   36AALFP7532RIZD      NAZNEEN MUSTAFA
//   (no phone)   NO                   992500554556
//   7133183975   NO                   845789670830 noor@shanglootrav
//   9515545676   NO                   Z5057813 travel@justgroup.org
//   1561203623   NO                   426265948900 info@travelarc.in
//   9619609650   NO                   819725153194 madhukrishnamurth
//   5757700568   NO                   927410133480 samir@thetamara.c
//   3759080276   NO                   463856805269 manjulark@royalto
//   4953922385   NO                   646777158182 arun@tgihotels.co
//   1998332792   NO                   999255070206 607nalini@gmail.c
//   6498408460   NO                   207774613521 pjain@gmail.com
//   5423984605   NO                   8865 2739 0305 geeba315@gmail.
//   4310671585   NO                   Z4118209 milly@allaboutravel.n
//   9833951734   27AFSPK085K1ZY       Anil
//   5512211585   NO                   263156219376 director@valmikit
