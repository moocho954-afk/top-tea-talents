// Missing-info questions (v1.3.2) — the in-house TTT form.
// Option lists are the casting form's EXACT option texts, captured from the
// live TaylorMade Miami Vice Tally form definition (tools/taylormade-work/
// <talent>/fill-plan.json, live_questions, captured 2026-11-23). Never edited
// by hand to a paraphrase — if the casting form changes, re-capture and
// regenerate this file from the new fill-plan. The Google Form bridge
// (formId 1gBRQQsI7bJF-CyAISfUdV8QVmJ_Mo1mAjoef_zT85Yw) used the same lists.
//
// `store` says how the selected option lands on the talent record:
// - "full": the exact option text (the submitter matches it by substring).
// - "short": the text before " — " (YES/NO) — the submitter checks these
//   with ==, so the short code is what the record must carry.
// - "bool": the question is a single checkbox; answering stores true.
// - "value": a date/number/text value, stored as given (validated).

export type MissingInfoKind = "choice" | "multi" | "date" | "number" | "text" | "bool";
export type MissingInfoQuestion = {
  id: string; label: string; kind: MissingInfoKind;
  options: string[] | null; store: "full" | "short" | "bool" | "value";
  path: string; order: number; applies?: string | null; requires?: string | null;
};

export const MISSING_INFO_QUESTIONS: MissingInfoQuestion[] = [
  { id: "gender", label: "Gender", kind: "choice", options: ["Male", "Female", "Non-Binary / Other"], store: "full", path: "demographics.gender", order: 1, applies: null, requires: null },
  { id: "ethnicity", label: "Ethnic appearance", kind: "choice", options: ["White / Caucasian", "Black / African American", "Hispanic / Latino", "Asian / South Asian", "Middle Eastern", "Biracial / Mixed", "Other"], store: "full", path: "demographics.ethnicity", order: 2, applies: null, requires: null },
  { id: "height", label: "Height", kind: "choice", options: ["Shorter than 2'0", "2'0", "2'1", "2'2", "2'3", "2'4", "2'5", "2'6", "2'7", "2'8", "2'9", "2'10", "2'11", "3'0", "3'1", "3'2", "3'3", "3'4", "3'5", "3'6", "3'7", "3'8", "3'9", "3'10", "3'11", "4'0", "4'1", "4'2", "4'3", "4'4", "4'5", "4'6", "4'7", "4'8", "4'9", "4'10", "4'11", "5'0", "5'1", "5'2", "5'3", "5'4", "5'5", "5'6", "5'7", "5'8", "5'9", "5'10", "5'11", "6'0", "6'1", "6'2", "6'3", "6'4", "6'5", "6'6", "6'7", "6'8 or taller"], store: "full", path: "height", order: 3, applies: null, requires: null },
  { id: "hairColor", label: "Hair color", kind: "choice", options: ["Black", "Dark Brown", "Light Brown", "Blonde", "Red / Auburn", "Gray / Salt & Pepper", "White", "Bald / Shaved", "Fashion Color"], store: "full", path: "hairColor", order: 4, applies: null, requires: null },
  { id: "dateOfBirth", label: "Date of birth", kind: "date", options: null, store: "value", path: "demographics.dateOfBirth", order: 5, applies: null, requires: null },
  { id: "weightLbs", label: "Weight (lbs)", kind: "number", options: null, store: "value", path: "measurements.weightLbs", order: 6, applies: null, requires: null },
  { id: "shirt", label: "Shirt / blouse size", kind: "choice", options: ["XS", "S", "M", "L", "XL", "2XL", "3XL", "4XL+"], store: "full", path: "clothing[\"Shirt / blouse size\"]", order: 7, applies: null, requires: null },
  { id: "shoe", label: "Shoe size", kind: "choice", options: ["Smaller than TODDLER 7", "TODDLER 7", "TODDLER 8", "TODDLER 9", "TODDLER 10", "TODDLER 11", "TODDLER 12", "1", "1.5", "2", "2.5", "3", "3.5", "4", "4.5", "5", "5.5", "6", "6.5", "7", "7.5", "8", "8.5", "9", "9.5", "10", "10.5", "11", "11.5", "12", "12.5", "13", "13.5", "14", "14.5", "15", "Larger than 15"], store: "full", path: "clothing[\"Shoe size\"]", order: 8, applies: null, requires: null },
  { id: "hairCut", label: "Hair cut / modification", kind: "choice", options: ["YES — production can do whatever they want to my hair", "MAYBE — depends on what production wants to do", "NO — production cannot cut my hair", "👴 I don't have any hair for production to cut"], store: "full", path: "demographics.hairCut", order: 9, applies: null, requires: null },
  { id: "facialHair", label: "Facial hair", kind: "choice", options: ["I do not have facial hair", "I have facial hair and am WILLING to shave ✅", "I have facial hair and am UNABLE to shave ❌"], store: "full", path: "demographics.facialHair", order: 10, applies: null, requires: null },
  { id: "bathingSuit", label: "Bathing suit / wardrobe comfort", kind: "choice", options: ["YES — I am COMFORTABLE wearing a BATHING SUIT", "NO — I do not wish to be considered for any BATHING SUIT ROLES"], store: "short", path: "demographics.bathingSuit", order: 11, applies: null, requires: null },
  { id: "tattoos", label: "Tattoos", kind: "choice", options: ["NO — I do not have tattoos", "YES — I have tattoos"], store: "short", path: "demographics.tattoos", order: 12, applies: null, requires: null },
  { id: "tattooLocations", label: "Tattoo locations", kind: "multi", options: ["Arm", "Ankle", "Back", "Calf", "Chest", "Collarbone", "Face", "Finger", "Foot", "Forearm", "Hand", "Leg", "Neck", "Ribs", "Shoulder", "Stomach", "Thigh", "Wrist"], store: "full", path: "demographics.tattooLocations", order: 13, applies: null, requires: "tattoos=YES" },
  { id: "neck", label: "Neck size (men)", kind: "choice", options: ["13", "13.5", "14", "14.5", "15", "15.5", "16", "16.5", "17", "17.5", "18", "18.5", "19", "19.5", "20"], store: "full", path: "clothing[\"Neck size (men)\"]", order: 14, applies: "Male", requires: null },
  { id: "sleeve", label: "Sleeve length (men)", kind: "choice", options: ["30", "31", "32", "33", "34", "35", "36", "37", "38"], store: "full", path: "clothing[\"Sleeve length (men)\"]", order: 15, applies: "Male", requires: null },
  { id: "waist", label: "Pants waist (men)", kind: "choice", options: ["26", "27", "28", "29", "30", "31", "32", "33", "34", "35", "36", "37", "38", "39", "40", "41", "42", "43", "44", "45", "46", "47", "48", "49", "50", "51", "52"], store: "full", path: "clothing[\"Pants waist (men)\"]", order: 16, applies: "Male", requires: null },
  { id: "inseam", label: "Pants inseam (men)", kind: "choice", options: ["26", "27", "28", "29", "30", "31", "32", "33", "34", "35", "36"], store: "full", path: "clothing[\"Pants inseam (men)\"]", order: 17, applies: "Male", requires: null },
  { id: "jacket", label: "Suit jacket size (men)", kind: "choice", options: ["34S", "34R", "34L", "36S", "36R", "36L", "38S", "38R", "38L", "40S", "40R", "40L", "42S", "42R", "42L", "44S", "44R", "44L", "46S", "46R", "46L", "48S", "48R", "48L", "50S", "50R", "50L", "52S", "52R", "52L", "54S", "54R", "54L", "56S", "56R", "56L"], store: "full", path: "clothing[\"Suit jacket size (men)\"]", order: 18, applies: "Male", requires: null },
  { id: "pantsJean", label: "Pants / jean size (women)", kind: "choice", options: ["00", "0", "2", "4", "6", "8", "10", "12", "14", "16", "18", "20", "22", "24+"], store: "full", path: "clothing[\"Pants / jean size (women)\"]", order: 14, applies: "Female", requires: null },
  { id: "dress", label: "Dress size", kind: "choice", options: ["0", "2", "4", "6", "8", "10", "12", "14", "16", "18", "20+"], store: "full", path: "clothing[\"Dress size\"]", order: 15, applies: "Female", requires: null },
  { id: "braBand", label: "Bra band size (women)", kind: "choice", options: ["28", "30", "32", "34", "36", "38", "40", "42", "44", "46", "48"], store: "full", path: "clothing[\"Bra band size (women)\"]", order: 16, applies: "Female", requires: null },
  { id: "braCup", label: "Bra cup size (women)", kind: "choice", options: ["AA", "A", "B", "C", "D", "DD / E", "DDD / F", "G", "H", "I+"], store: "full", path: "clothing[\"Bra cup size (women)\"]", order: 17, applies: "Female", requires: null },
  { id: "vintageVehicle", label: "Do you have a 1960–1989 car we can use for filming on set?", kind: "choice", options: ["YES — I have a car that can be used for filming", "NO — I do not have a car that can be used for filming"], store: "short", path: "demographics.vintageVehicle", order: 19, applies: null, requires: null },
  { id: "carYear", label: "Car year", kind: "number", options: null, store: "value", path: "demographics.carYear", order: 20, applies: null, requires: "vintageVehicle=YES" },
  { id: "carColor", label: "Car color", kind: "choice", options: ["Black", "White", "Silver / Gray", "Red", "Blue", "Green", "Yellow", "Brown / Tan / Beige", "Gold", "Orange", "Other"], store: "full", path: "demographics.carColor", order: 21, applies: null, requires: "vintageVehicle=YES" },
  { id: "carMakeModel", label: "Make / model", kind: "text", options: null, store: "value", path: "demographics.carMakeModel", order: 22, applies: null, requires: "vintageVehicle=YES" },
  { id: "carType", label: "Car type", kind: "choice", options: ["Box Van", "Camper / RV", "Compact Sedan", "Convertible", "Minivan", "Motorcycle", "Sedan", "SUV (large)", "SUV (small / crossover)", "Truck", "Other"], store: "full", path: "demographics.carType", order: 23, applies: null, requires: "vintageVehicle=YES" },
  { id: "filmingDates", label: "Filming availability", kind: "multi", options: null, store: "full", path: "demographics.filmingDates", order: 24, applies: null, requires: null },
  { id: "paidFitting", label: "Paid fitting availability", kind: "choice", options: ["YES — I can attend a fitting before filming", "NO — I would not be available for a fitting before filming (we probably won't be able to book you for this movie)"], store: "short", path: "demographics.paidFitting", order: 25, applies: null, requires: null },
  { id: "overnights", label: "Are you okay with overnights or splits?", kind: "choice", options: ["OK SPLITS ONLY", "OK SPLITS & OVERNIGHTS", "NOT AVAILABLE for splits or overnights"], store: "full", path: "demographics.overnights", order: 26, applies: null, requires: null },
  { id: "legalToWork", label: "You must be legal to work in the USA", kind: "choice", options: ["YES — I AM LEGAL TO WORK IN THE USA & CAN PROVIDE EXACTLY WHAT IS NEEDED", "NO — I AM NOT LEGAL TO WORK IN THE USA (NO NEED TO APPLY)"], store: "short", path: "demographics.legalToWork", order: 27, applies: null, requires: null },
  { id: "southFloridaResident", label: "Miami / South Florida Native or Longtime Resident", kind: "bool", options: ["Yes — I am a Miami / South Florida native or longtime resident"], store: "bool", path: "demographics.southFloridaResident", order: 28, applies: null, requires: null },
  { id: "english", label: "English language", kind: "choice", options: ["YES — I can UNDERSTAND & SPEAK the English language", "NO — I cannot UNDERSTAND & SPEAK the English language"], store: "short", path: "demographics.english", order: 29, applies: null, requires: null },
];

// The 37 filming dates from the live TaylorMade Miami Vice form
// (fill-plan live_questions, "Filming availability"). Used ONLY when the
// alert is tied to that form (formSlug "miamivice" or an opportunity whose
// title contains "Miami Vice"). Any other opportunity resolves its dates
// from its own production_dates, or the question falls back to free text.
export const TAYLORMADE_MIAMI_VICE_DATES: string[] = ["12/7 (MON)", "12/8 (TUE)", "12/9 (WED)", "12/10 (THU)", "12/11 (FRI)", "12/12 (SAT)", "12/14 (MON)", "12/15 (TUE)", "12/16 (WED)", "12/17 (THU)", "12/18 (FRI)", "12/19 (SAT)", "1/5 (TUE)", "1/6 (WED)", "1/7 (THU)", "1/8 (FRI)", "1/9 (SAT)", "1/12 (TUE)", "1/13 (WED)", "1/14 (THU)", "1/15 (FRI)", "1/16 (SAT)", "1/17 (SUN)", "1/19 (TUE)", "1/20 (WED)", "1/21 (THU)", "1/22 (FRI)", "1/23 (SAT)", "1/25 (MON)", "1/26 (TUE)", "1/27 (WED)", "1/28 (THU)", "1/29 (FRI)", "1/30 (SAT)", "2/2 (TUE)", "2/3 (WED)", "2/6 (SAT)"];

export function shortCode(optionText: string): string {
  const i = optionText.indexOf(" — ");
  return (i >= 0 ? optionText.slice(0, i) : optionText).trim();
}

