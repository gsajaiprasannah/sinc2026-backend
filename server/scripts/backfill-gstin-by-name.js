#!/usr/bin/env node
/**
 * backfill-gstin-by-name.js — re-attach delegate GSTINs using NAME + COMPANY.
 *
 * WHY THIS EXISTS
 *   The first backfill matched on the last 10 digits of the mobile number.
 *   That is wrong whenever two delegates share a phone: Zahoor Qari and Nasir
 *   Shah both carry 9419079127 and hold DIFFERENT GSTINs, and one GSTIN
 *   (33AABAT3592J1ZB) ended up spread across seven unrelated delegates.
 *
 *   Source of truth is the registration spreadsheet, where each GSTIN sits on
 *   the same row as the person and company that supplied it.
 *
 * MATCHING, strongest first. A record is only written on a confident match:
 *   1. email exact
 *   2. normalised name exact AND company tokens overlap
 *   3. normalised name exact and unique across all delegates
 *   4. phone match AND normalised name exact
 *   Anything else is reported as UNMATCHED or AMBIGUOUS and left alone.
 *
 *   state_code is always derived from the GSTIN's first two digits, never typed.
 *
 * SAFETY
 *   - Dry run by default; --apply required to write.
 *   - --apply snapshots id/name/gstin/state_code to gstin_namefix_backup.
 *   - --revert restores that snapshot.
 *   - Reports every delegate whose stored GSTIN this would CHANGE, so a wrong
 *     value being corrected is visible rather than silent.
 *
 * USAGE
 *   node server/scripts/backfill-gstin-by-name.js
 *   node server/scripts/backfill-gstin-by-name.js --apply
 *   node server/scripts/backfill-gstin-by-name.js --revert --apply
 */

const db = require('../db');
const { validateGstin } = require('../lib/gst');

const APPLY = process.argv.includes('--apply');
const REVERT = process.argv.includes('--revert');
const BACKUP = 'gstin_namefix_backup';

// From "dlegats gst number.xlsx" — only rows whose GSTIN passes format AND
// checksum. 18 malformed entries in that file are deliberately excluded and
// listed at the foot of this file.
const RECORDS = [
  {"gstin": "01AABCM5918P1ZB", "name": "MOHMAD AKRAM SIAH", "company": "MEENA TRAVELS PVT LTD", "mobile": "9419018982", "email": "noor@shanglootravels.com"},
  {"gstin": "01AABFE7020K1ZY", "name": "Ather Yameen", "company": "Earth Explorers Travel and Tours", "mobile": "9797722244", "email": "atheryameen@gmail.com"},
  {"gstin": "01AABPQ2167K1ZV", "name": "Zahoor Qari", "company": "Air Links Tours & Travels", "mobile": "9419079127", "email": ""},
  {"gstin": "01AAECC8609A1ZB", "name": "NASIR SHAH", "company": "CULTURE & NATURE EXPEDITIONS TOURS & TRAVELS PVT. LTD", "mobile": "9419079127", "email": "zahoorqari@gmail.com"},
  {"gstin": "01ACPPW5952J2Z1", "name": "Asif Hussain wani", "company": "Down Dale Holidays", "mobile": "9906560777", "email": "info@travelarc.in"},
  {"gstin": "01ATBPB2760Q1ZW", "name": "Mohd mohsin Bhat", "company": "Luxury retreat hotel Pahlgam", "mobile": "9796120000", "email": ""},
  {"gstin": "01ATZPB1072B1Z8", "name": "Billal Bhat Bhat", "company": "Capricorn Tour and Travels", "mobile": "8527833865", "email": ""},
  {"gstin": "01BFPPS4706G1ZG", "name": "Shaqoor Ahmad Sheikh", "company": "Nishat Tours And Travels", "mobile": "7006655272", "email": "travel@justgroup.org"},
  {"gstin": "01CBRPR0665N1Z5", "name": "FIRDOUS ALI", "company": "TRAVEL ARC", "mobile": "9419019193", "email": "trogonadventure@gmail.com"},
  {"gstin": "01CCGPS0206J1Z0", "name": "MOHAMAD FAISAL SHAH", "company": "SHAHJEE EMPORIUM", "mobile": "9797322000", "email": "atheryameen@gmail.com"},
  {"gstin": "06AABPB9828N1ZG", "name": "PARAMJIT BAWA", "company": "Auxilia Networks", "mobile": "9873707679", "email": ""},
  {"gstin": "07AAACM1267A1Z1", "name": "Deepak Kumarr Bhatnagar", "company": "Minar Travels ( I) Pvt. Ltd.", "mobile": "9818352881", "email": ""},
  {"gstin": "07AABCF8168Q1ZW", "name": "Santosh Sharma", "company": "BookMyJet", "mobile": "9910493247", "email": ""},
  {"gstin": "07AAJFO2730N1ZZ", "name": "Sandeep Khetarpal", "company": "One Globe Services", "mobile": "9999065666", "email": ""},
  {"gstin": "07AAPFC1572J1Z7", "name": "Siddharth Jain", "company": "Chalo DMC LLP", "mobile": "9811230099", "email": "jagat@chalodmc.com"},
  {"gstin": "08AAFCR0675Q1ZQ", "name": "Rajendra singh", "company": "RAJASTHAN ROUTES TRAILS PVT LTD", "mobile": "7414001100", "email": ""},
  {"gstin": "09AAACC9677L1ZY", "name": "Sunil Bahadur Satyawakta", "company": "Civica Travels Pvt Ltd", "mobile": "9415024598", "email": ""},
  {"gstin": "09AAHCM7204Q2ZV", "name": "AHMAD MAAZ", "company": "ROYAL TOUR & TRAVEL INDIA PVT LTD", "mobile": "9935500551", "email": ""},
  {"gstin": "19AABCG1716F1ZX", "name": "Maanav Saraf", "company": "Gainwell Travel", "mobile": "9874623332", "email": ""},
  {"gstin": "19AACCW3908N1ZT", "name": "June Mukherjee", "company": "Whitehat Media Pvt. Ltd.", "mobile": "9007478350", "email": ""},
  {"gstin": "19AADCC5722F1ZT", "name": "Sandipa Malakar", "company": "The Rajabari Bawali- Bawali Estates Pvt. Ltd.", "mobile": "9007075566", "email": "carolann@therajbari.com"},
  {"gstin": "19AADCV9803C1ZA", "name": "Chandra Prakash Poddar", "company": "Vinayaka Tourism Pvt Ltd", "mobile": "9830036033", "email": ""},
  {"gstin": "19AAECA8796N1ZP", "name": "Sanjeev Mehra", "company": "AARYAN LEISURE & HOLIDAYS PVT LTD", "mobile": "9830960004", "email": "vanessa.mehra@aaryanholidays.com"},
  {"gstin": "19AANCS0983L1ZL", "name": "Sandeep Kumar Sett", "company": "Sunshine Tours India Pvt Ltd", "mobile": "9830431484", "email": "annapurna.sett@gmail.com"},
  {"gstin": "19ACQPA8488A1ZC", "name": "Jay Agarwal", "company": "Hillpeak Tours", "mobile": "9163235870", "email": "vani0800@gmail.com"},
  {"gstin": "21AAFCK0211M1Z1", "name": "DEBASISH MAHAPATRA", "company": "K7 HOLIDAYS & TRAVELS PVT LTD", "mobile": "9337123999", "email": ""},
  {"gstin": "21AAGCV8370D1ZG", "name": "Amar Kumar Sahu", "company": "VWV TOURISM PVT LTD", "mobile": "7008134870", "email": "ceo@pipulhotelsandresorts.com"},
  {"gstin": "21ATDPS1628N1ZK", "name": "Anurag Sahoo", "company": "Travelerz Destination Management Services", "mobile": "9702354459", "email": "info@sevenseasdreamvacations.com"},
  {"gstin": "21AZRPK9305J1Z4", "name": "RAHUL KUMAR", "company": "MAA GITA HOLIDAYS", "mobile": "9778062483", "email": ""},
  {"gstin": "23AACCT3376M1Z3", "name": "MAHENDRA PRATAP SINGH", "company": "TRAVEL INDIA TOURISM PVT LTD", "mobile": "9893574731", "email": "neelam@travelindiatourism.com"},
  {"gstin": "23ABRPA2151Q1ZJ", "name": "Shantanu Trivedi", "company": "Flywings Group", "mobile": "9826048388", "email": ""},
  {"gstin": "24AANCB3653L1ZE", "name": "VIKAS GUPTA", "company": "BOOK N FLY PVT LTD", "mobile": "9906036313", "email": "info@smilingtrips.com"},
  {"gstin": "27AAACA4897J1ZA", "name": "Maneka Mulchandani", "company": "Autoriders International Ltd", "mobile": "9820077107", "email": ""},
  {"gstin": "27AAACR4057P1ZX", "name": "Vaibhav Kedia", "company": "RAMNIRANJAN KEDIA RENT A CAR PRIVATE LIMITED", "mobile": "9820354101", "email": ""},
  {"gstin": "27AAAPB9837G1ZR", "name": "MUKESH BATRA", "company": "Dr Batra's Healthcare", "mobile": "9022929018", "email": "louisa@drbatras.com"},
  {"gstin": "27AABCC5456E1ZT", "name": "VADAKKUMCHERIL ABDUL KAREEM", "company": "FLYCREATIVE ONLINE LIMITED", "mobile": "9821027983", "email": ""},
  {"gstin": "27AACCE7027N1ZC", "name": "Mehboob Shaikh", "company": "Travel Elect India Pvt Ltd", "mobile": "9822030908", "email": "krishna@travelmastersonline.com"},
  {"gstin": "27AACCK2338N1ZA", "name": "AMARJIT LIDDER", "company": "KALEIDOSCOPE TRAVEL CONSULTANTS PVT LTD", "mobile": "8283847589", "email": ""},
  {"gstin": "27AAECJ0878J1Z8", "name": "Prasad Shett", "company": "Jigsaw Travels Pvt Ltd", "mobile": "9763720450", "email": ""},
  {"gstin": "27AAICD3388H1ZC", "name": "Dilip Soge", "company": "DBS Holidays India Pvt Ltd", "mobile": "9850545349", "email": ""},
  {"gstin": "27AAIFE2205M1ZG", "name": "Manish Sushilkumar Gupta", "company": "Encore Holidays", "mobile": "9373177400", "email": ""},
  {"gstin": "27AAJCR8494B1Z0", "name": "Lalit Varma", "company": "Roving steps pvt ltd", "mobile": "9372020385", "email": "sunillondhe5@gmail.com"},
  {"gstin": "27AALFT9656J1ZB", "name": "Arvind Tandon", "company": "Think Events Solution LLP", "mobile": "9820218210", "email": "anju@thearktravelgroup.com"},
  {"gstin": "27AALPG1452D1Z2", "name": "SURESH GULRAJANI", "company": "Enjoy Travels", "mobile": "9820025886", "email": "mail@enjoytravels.in"},
  {"gstin": "27AAQPR3055C1ZL", "name": "SHAHBEHRAM RABBANI", "company": "GOODWILL TOURS AND TRAVELS", "mobile": "9823021337", "email": "goodwillttt@gmail.com"},
  {"gstin": "27AASFV0549D1ZX", "name": "HARSHAD SANTOSH RATHOD", "company": "V T Tourism LLP & Vikram Travels", "mobile": "9867564471", "email": "bharat@travelmastersonline.com"},
  {"gstin": "27AFVPM4974R1Z2", "name": "Nishant S Mehta", "company": "Toogle", "mobile": "9820165612", "email": "vistatravel.satya@gmail.com"},
  {"gstin": "27AIHPG5582E1Z8", "name": "Satyaprakash Gupta", "company": "Vista Tours & Travels", "mobile": "9820165612", "email": "vistatravel.satya@gmail.com"},
  {"gstin": "27ALJPB2792G1Z3", "name": "Vishnu Bhagwan", "company": "udChalo", "mobile": "9873991873", "email": "km.ruby@aol.com"},
  {"gstin": "27ALZPK7317C1ZR", "name": "Dipesh Khatri", "company": "ULTIMATE GETAWAYS", "mobile": "9049998003", "email": "nikita@ultimategetaways.in"},
  {"gstin": "27AOPPS9161R1ZM", "name": "Deepan Shah", "company": "Travel Exotico", "mobile": "9004389283", "email": ""},
  {"gstin": "27ASNPS6368L1ZP", "name": "Mamata Shah", "company": "Mayur Pankh", "mobile": "9819231973", "email": ""},
  {"gstin": "27AUAPB6693C1ZU", "name": "RAJENDRA BOTHRA", "company": "EASE VOYAGES", "mobile": "9021505152", "email": "mpreetish@yahoo.com"},
  {"gstin": "27BBGPN7516Q1ZX", "name": "SAVITA NANEKAR", "company": "SAVIRAJ TRAVELS", "mobile": "8793097097", "email": ""},
  {"gstin": "27CXEPK7796Q1ZA", "name": "Hrishikesh Kolhapure", "company": "K K TRAVELS", "mobile": "9673990102", "email": "info@kktravels.com"},
  {"gstin": "29AAACF8398K1ZV", "name": "Govind Shankar", "company": "Freedom Holidays  & Leisure Travel Pvt Ltd", "mobile": "9845095098", "email": ""},
  {"gstin": "29AABCG4059M1Z7", "name": "Suresh Charles", "company": "The Birchwood Retreat", "mobile": "9886030105", "email": "shalini.khannacharles@gmail.com"},
  {"gstin": "29AABFF1399L2ZY", "name": "RANJINI NAMBIAR", "company": "Footloose Yatra Consultants", "mobile": "9845048836", "email": "milly@allaboutravel.net"},
  {"gstin": "29AACCB3797N1ZY", "name": "ROHIT HANGAL", "company": "SPHERE TRAVELMEDIA & EXHIBITIONS PVT. LTD.,", "mobile": "9844092150", "email": ""},
  {"gstin": "29AACCR7212E1ZJ", "name": "RAMESH BABU G", "company": "RAMESH TOURS AND TRAVELS PVT LTD", "mobile": "7483142567", "email": "miteshrbabu10@gmail.com"},
  {"gstin": "29AAECB2113J1ZW", "name": "DN Raju", "company": "Bangalore Soma Vineyards pvt ltd", "mobile": "9448496170", "email": "anudarby@gmail.com"},
  {"gstin": "29AAEFH5079G1Z4", "name": "Rajendra Singh Bhati", "company": "Hospitalityunlimited", "mobile": "9449865351", "email": "607nalini@gmail.com"},
  {"gstin": "29AAFCA7289R1ZL", "name": "Badiger Devendra", "company": "Atlas Hoppers Private Limited", "mobile": "9845449570", "email": ""},
  {"gstin": "29AAFFW0299J1ZL", "name": "jagmohan bhutada", "company": "wing my dreams travel hub LLP", "mobile": "9986003600", "email": "seema@wingmydreamss.com"},
  {"gstin": "29AAGFR0065C1ZG", "name": "Sundar Rajkumar", "company": "ROYAL TOURS AND TRAVELS", "mobile": "9632539999", "email": "manjulark@royaltour.in"},
  {"gstin": "29AAKAS8612B1ZE", "name": "Balan Nair", "company": "Bangalore Institute of Aviation and Logistics", "mobile": "9844329950", "email": "geeba315@gmail.com"},
  {"gstin": "29AAQPH0317K1ZJ", "name": "Harish Shah", "company": "M&C Aviation Holdings Pte Ltd", "mobile": "8884328262", "email": "aneera.shah@gmail.com"},
  {"gstin": "29AAUFN1414D1Z9", "name": "MANISH KAUSHAL", "company": "Nambiar Hospitality LLP", "mobile": "9901973709", "email": "shweata2004@gmail.com"},
  {"gstin": "29AAWFT3387M1ZY", "name": "Samarth Vaidya", "company": "TripDoor", "mobile": "9845865485", "email": ""},
  {"gstin": "29AAYFM7647K1Z4", "name": "KRISHNAMURTHY A N", "company": "MKTRAVELS", "mobile": "9880299969", "email": "madhukrishnamurthy9@gmail.com"},
  {"gstin": "29ACBFA6180C1ZM", "name": "Seeni Sankar", "company": "The Serai Resorts", "mobile": "9900476403", "email": ""},
  {"gstin": "29ACLPD2723J2ZJ", "name": "WILLIAM ANTONY DSOUZA", "company": "Globe Travels", "mobile": "9845080597", "email": ""},
  {"gstin": "29AFAPS5477C1Z8", "name": "Srikant Krishnaswami", "company": "Indus Outback Ventures", "mobile": "9900169612", "email": "info@frshtryp.com"},
  {"gstin": "29AFFPG0131C1Z6", "name": "Anurag Gupta", "company": "Corporate Outbound", "mobile": "9886326567", "email": ""},
  {"gstin": "29APNPA4288A1ZX", "name": "Abhinandan S S", "company": "Aries Tours and Travels", "mobile": "7353311234", "email": "wetravelworld09@gmail.com"},
  {"gstin": "29BCMPS4480H1ZY", "name": "Margaret Rasquinha", "company": "Dreamscape Tours", "mobile": "9448119224", "email": "cherianusha52@gmail.com"},
  {"gstin": "29BJFPK8871G3ZN", "name": "Kalaskruthi N Gowda", "company": "Travel Mage", "mobile": "9535553555", "email": "ravitvm66@gmail.com"},
  {"gstin": "32AAACH6770PHZS", "name": "Devika K. R", "company": "CGH Earth Experience Hotels", "mobile": "7358455755", "email": ""},
  {"gstin": "32AACCR7529L1Z5", "name": "Raja Gopal Hariharan", "company": "UDS Group of Hotels", "mobile": "9388353664", "email": ""},
  {"gstin": "32AACCU1941K1ZG", "name": "John George", "company": "WIZZ Holidays", "mobile": "9961456566", "email": ""},
  {"gstin": "32AADCM3357Q1Z5", "name": "Dinesh Rai", "company": "Crowne Plaza Kochi", "mobile": "9246800245", "email": ""},
  {"gstin": "32AAFCG5655F2ZQ", "name": "Sam Varghese", "company": "Groowynd Holidays India Pvt Ltd", "mobile": "9747007479", "email": ""},
  {"gstin": "32ABKPN3019M1ZL", "name": "Nirmala Lilly", "company": "Infinity Hospitality Services", "mobile": "9846061219", "email": "rani@viceregaltravels.com"},
  {"gstin": "33AAACA7483L2ZG", "name": "R Kalathinathan", "company": "HOTEL AMBICA EMPIRE", "mobile": "9382139798", "email": ""},
  {"gstin": "33AAACC3027G1ZA", "name": "BASKAR SUBBIAH", "company": "CHAMPION TRAVEL AND TOUR PVT LTD", "mobile": "9841067873", "email": ""},
  {"gstin": "33AAACD1219K2Z1", "name": "Ganesh VM", "company": "Diana World Travel Pvt ltd", "mobile": "6382132034", "email": "jyoganty@gmail.com"},
  {"gstin": "33AAACK9254B1ZV", "name": "Hema RV Chander", "company": "Kalpataru Tours India Private limited", "mobile": "9840986923", "email": ""},
  {"gstin": "33AAACP5822A1Z2", "name": "Pazhani Murugesan", "company": "Pioneer Aero Travels ( Madras) Pvt Ltd", "mobile": "9840044774", "email": ""},
  {"gstin": "33AABAT3592J1ZB", "name": "PARAMESWARAN SUSEENDRAN", "company": "ASSOCIATED TOURS", "mobile": "9840029446", "email": ""},
  {"gstin": "33AABCC1990M1ZK", "name": "S N GOKULARAMANAN", "company": "Chennai Airciti Tours and Travel Pvt Ltd", "mobile": "9840047077", "email": ""},
  {"gstin": "33AABCC8533C1Z4", "name": "Arulmony Bright Manohar", "company": "Ceeben World Travel Pvt Ltd", "mobile": "9677226795", "email": "shmohideen387@gmail.com"},
  {"gstin": "33AABCG4766H1ZN", "name": "Jamal Mohamed Jahir Hussain", "company": "Greatwings travels p ltd", "mobile": "9443305678", "email": ""},
  {"gstin": "33AABCG8996R1ZM", "name": "Ravindren Shanmugam", "company": "Arunai Anantha Resorts , Gemspark Hotels P Ltd.", "mobile": "9535553555", "email": "kalaskruthi@travelmage.co"},
  {"gstin": "33AACCB2820J1Z3", "name": "Kannappan Babu", "company": "Bhagya Travels and Tours Pvt Ltd", "mobile": "9840037711", "email": ""},
  {"gstin": "33AACCL4484G1ZK", "name": "Subramaniam Seetharam", "company": "Louder design solutions", "mobile": "9884061506", "email": "subi.lena@gmail.com"},
  {"gstin": "33AADCP4820B1Z1", "name": "Veerakumar B N", "company": "Preveen Air Travels Private Limited", "mobile": "9841044207", "email": ""},
  {"gstin": "33AAGCG4079C1ZU", "name": "Lawrence Rosario Michael", "company": "GOODNESS TRVELS AND SERVICES PRIVATE LIMITED", "mobile": "9841902302", "email": ""},
  {"gstin": "33AAHCG5701A1ZA", "name": "GAYATHRI ABK", "company": "GJ PHOENIX TRAVEL AND LEISURE PVT LTD", "mobile": "8754450825", "email": ""},
  {"gstin": "33AAIFF1943M1ZB", "name": "Rajesh Elumalai", "company": "10/16, SIDCO Nagar, Villivakkam", "mobile": "9345041235", "email": ""},
  {"gstin": "33AAIPP1159P1ZA", "name": "Pawan Kumar Gupta", "company": "Peekay tours and travels", "mobile": "9444012320", "email": "pawan1965@gmail.com"},
  {"gstin": "33AAMCP2812J1ZF", "name": "Shankar S M", "company": "Prego", "mobile": "9444009654", "email": ""},
  {"gstin": "33AAVFA2937R2ZO", "name": "Vishal Raj Munglani", "company": "ANDAAZ DESIGNS", "mobile": "9176609908", "email": ""},
  {"gstin": "33AEFPJ4108P1ZG", "name": "JEYASEKARAN SELVANAYAGAM", "company": "TRAVEL N MORE", "mobile": "9884111430", "email": "bulusu31@gmail.com"},
  {"gstin": "33AEKPG3285M1Z8", "name": "Geetha Balakrishnan", "company": "SRC Tours And TRAVELS", "mobile": "9941114041", "email": ""},
  {"gstin": "33AHTPR7866D1ZQ", "name": "FATHIMA BAI MOHAMED RAHIM SAIT", "company": "SOUTH GATES INTERNATIONAL", "mobile": "9840441200", "email": ""},
  {"gstin": "33ASCPK7804Q2ZD", "name": "Premnath NK", "company": "FOCUS TOURISM EVENTZ", "mobile": "9841018266", "email": "subedar1956@gmail.com"},
  {"gstin": "33BCOPH2690Q1ZZ", "name": "SURESH BETHI", "company": "BSH VACATIONS ( TM - PLANAHOLIDAY)", "mobile": "8879967656", "email": ""},
  {"gstin": "33CTPPS9504M1ZW", "name": "Santhoshkumar S", "company": "SANTHOSH HOLIDAYS", "mobile": "9003594959", "email": ""},
  {"gstin": "34AAECT9952D1Z7", "name": "Arun Kumar VK", "company": "TGI Hotels and Hospitality Services Pvt Ltd", "mobile": "9655220000", "email": ""},
  {"gstin": "36AACCP5283H1Z9", "name": "Bala Koteswara Rao Gaddipati", "company": "PRAGATI GREEN MEADOWS AND RESORTS LIMITED", "mobile": "9989986969", "email": ""},
  {"gstin": "36AAGFU7749E1ZT", "name": "RAVI AGARWAL", "company": "URBBAN TRENDS", "mobile": "9398285349", "email": ""},
  {"gstin": "36AALFV2899R1ZV", "name": "HARI KISHAN VALMIKI", "company": "VALMIKI TRAVEL & TOURISM SOLUTIONS", "mobile": "8374566600", "email": "director@valmikitravels.com"},
  {"gstin": "36AAMCD1197Q1ZV", "name": "Mounika Bhomi Reddy", "company": "Destination memories private limited", "mobile": "8019491193", "email": ""},
  {"gstin": "36BEQPA3959D2ZE", "name": "Anil Kolla", "company": "ANIL Tours and Travels", "mobile": "9666632888", "email": "info.aniltravels@gmail.com"}
];

// --- normalisation ---------------------------------------------------------
// Titles are stripped because the delegate table had them removed earlier but
// the spreadsheet still carries them; punctuation and double spaces go so that
// "S.N. Gokularamanan" and "SN GOKULARAMANAN" compare equal.
const TITLES = /^(mr|mrs|ms|miss|dr|prof|capt|adv|ca|cs|er|shri|smt|sri|sk)\.?\s+/i;
function normName(s) {
  let v = String(s || '').trim();
  while (TITLES.test(v)) v = v.replace(TITLES, '');
  return v.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}
const STOP = new Set(['pvt', 'private', 'ltd', 'limited', 'llp', 'and', 'the', 'co', 'company',
  'india', 'tours', 'travel', 'travels', 'holidays', 'services', 'hotels', 'group', 'international']);
function companyTokens(s) {
  return new Set(String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
    .filter((t) => t.length > 2 && !STOP.has(t)));
}
function tokensOverlap(a, b) {
  const A = companyTokens(a), B = companyTokens(b);
  if (!A.size || !B.size) return false;
  for (const t of A) if (B.has(t)) return true;
  return false;
}
const last10 = (p) => String(p || '').replace(/\D/g, '').slice(-10);

async function main() {
  if (REVERT) return revert();

  const people = await db.all(`
    SELECT p.id, p.name, p.email, p.phone, p.whatsapp, p.company, p.gstin, p.state_code,
           r.reg_number
      FROM participants p LEFT JOIN registrations r ON r.id = p.registration_id`);

  const byEmail = {}, byName = {}, byPhone = {};
  people.forEach((p) => {
    if (p.email) (byEmail[String(p.email).trim().toLowerCase()] ||= []).push(p);
    const n = normName(p.name);
    if (n) (byName[n] ||= []).push(p);
    [p.phone, p.whatsapp].forEach((ph) => { const k = last10(ph); if (k.length === 10) (byPhone[k] ||= []).push(p); });
  });

  const plan = [], ambiguous = [], unmatched = [];
  const claimed = new Map(); // participant id -> gstin, to catch two GSTINs fighting over one person

  for (const rec of RECORDS) {
    if (!validateGstin(rec.gstin).valid) { unmatched.push({ rec, why: 'GSTIN failed validation' }); continue; }
    const nName = normName(rec.name);
    let hit = null, how = '';

    const e = byEmail[rec.email];
    if (rec.email && e && e.length === 1) { hit = e[0]; how = 'email'; }

    if (!hit && nName && byName[nName]) {
      const cands = byName[nName];
      const withCo = cands.filter((c) => tokensOverlap(c.company, rec.company));
      if (withCo.length === 1) { hit = withCo[0]; how = 'name+company'; }
      else if (cands.length === 1) { hit = cands[0]; how = 'name'; }
      else if (cands.length > 1) ambiguous.push({ rec, why: `${cands.length} delegates share the name "${rec.name}"`, cands: cands.map((c) => c.id) });
    }

    if (!hit && nName && byPhone[last10(rec.mobile)]) {
      const withName = byPhone[last10(rec.mobile)].filter((c) => normName(c.name) === nName);
      if (withName.length === 1) { hit = withName[0]; how = 'phone+name'; }
    }

    if (!hit) { if (!ambiguous.some((a) => a.rec === rec)) unmatched.push({ rec, why: 'no confident match' }); continue; }

    if (claimed.has(hit.id)) {
      ambiguous.push({ rec, why: `delegate #${hit.id} already claimed by ${claimed.get(hit.id)}` });
      continue;
    }
    claimed.set(hit.id, rec.gstin);
    plan.push({ p: hit, rec, how, state: rec.gstin.slice(0, 2) });
  }

  const changed = plan.filter((x) => (x.p.gstin || '') !== x.rec.gstin);
  const same = plan.length - changed.length;
  const overwriting = changed.filter((x) => x.p.gstin);

  console.log(`\nSpreadsheet records: ${RECORDS.length}`);
  console.log(`Matched to a delegate: ${plan.length}   (already correct: ${same}, would change: ${changed.length})`);
  console.log(`Ambiguous: ${ambiguous.length}   Unmatched: ${unmatched.length}\n`);

  const byHow = {};
  plan.forEach((x) => { byHow[x.how] = (byHow[x.how] || 0) + 1; });
  console.log('matched by:', JSON.stringify(byHow), '\n');

  if (overwriting.length) {
    console.log(`REPLACING A DIFFERENT GSTIN ALREADY ON FILE (${overwriting.length}) — check these:`);
    overwriting.forEach((x) => console.log(`   ${x.p.reg_number || '-'} #${x.p.id} ${x.p.name}\n        was ${x.p.gstin}  ->  now ${x.rec.gstin}   [${x.how}]`));
    console.log('');
  }
  if (ambiguous.length) {
    console.log(`AMBIGUOUS — left untouched (${ambiguous.length}):`);
    ambiguous.forEach((a) => console.log(`   ${a.rec.gstin}  ${a.rec.name} | ${a.rec.company}  -> ${a.why}`));
    console.log('');
  }
  if (unmatched.length) {
    console.log(`NO DELEGATE FOUND (${unmatched.length}) — these people may not be registered:`);
    unmatched.forEach((u) => console.log(`   ${u.rec.gstin}  ${u.rec.name} | ${u.rec.company}`));
    console.log('');
  }

  if (!APPLY) { console.log('DRY RUN — nothing written. Re-run with --apply.\n'); return; }

  await db.transaction(async (tx) => {
    await tx.run(`DROP TABLE IF EXISTS ${BACKUP}`);
    await tx.run(`CREATE TABLE ${BACKUP} AS SELECT id, name, gstin, state_code FROM participants`);
    for (const x of changed) {
      await tx.run('UPDATE participants SET gstin=$1, state_code=$2 WHERE id=$3', [x.rec.gstin, x.state, x.p.id]);
    }
  });
  console.log(`\nDone. ${changed.length} delegate(s) updated. Backup in ${BACKUP}.`);
  console.log('Revert with: node server/scripts/backfill-gstin-by-name.js --revert --apply\n');
}

async function revert() {
  const t = await db.get(`SELECT to_regclass('${BACKUP}') AS t`);
  if (!t || !t.t) { console.error(`\nNo ${BACKUP} — nothing to revert.\n`); process.exitCode = 1; return; }
  if (!APPLY) { console.log('\nDRY RUN — re-run with --revert --apply.\n'); return; }
  await db.run(`UPDATE participants p SET gstin=b.gstin, state_code=b.state_code FROM ${BACKUP} b WHERE b.id=p.id`);
  console.log('\nRestored the previous GSTIN values.\n');
}

main().catch((e) => { console.error('\nFAILED:', e.message, '\n'); process.exitCode = 1; })
  .finally(() => db.pool.end());

/* Excluded from this file — malformed in the spreadsheet, need re-collecting:
   19ACQPA84881ZC  Jay Agarwal          27AFSPK085K1ZY   Anil Kadavil
   33AABAT         Kamleshwaran P S     AAPCS2982P1ZP    Shamim Ahmed Shah
   27AAACH92121ZC  Anil Haribal         36AALFP7532RIZD  Nazneen Taher
   27AIQPP1567K    Irshad Patel         AAACS0387F1ZI    Swadesh Kumar
   27AABCC5456E1ZT was fine; 9821027983 / 9820000000 were phone numbers.
   Plus: NA, AFAFD, -, ABCD124589 and four numeric test values. */
