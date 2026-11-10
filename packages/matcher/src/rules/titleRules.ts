// The 66 title rules, in the order the Python applies them: the first rule that matches the title wins,
// so moving a rule changes the result. Python: prototype/classify.py:27-100 (R07).
// Each pattern is written exactly as in the Python (Python regex dialect, see pyRegex.ts) and is
// tried on the lower-cased title padded with one space on each side.
// The four "AMBIG-*" codes are settled by the description in occupation.ts (R08, decision #70).
// "3542?" is settled by the language test in occupation.ts.
// Do not fix a miss by editing a pattern here: it changes behaviour that was measured (95% right on passed jobs).

export type TitleRule = {
  /** Line of the rule in classify.py */
  line: number;
  /** Python regex source, run on the lower-cased title */
  pattern: string;
  code: string;
  onList: "yes" | "no" | "unknown";
  confidence: "high" | "medium" | "low";
};

export const TITLE_RULES: readonly TitleRule[] = [
  { line: 29, pattern: String.raw`\bintern(ship)?\b|\bsummer analyst\b|placement student|co-?op\b`, code: "intern", onList: "no", confidence: "high" },
  { line: 30, pattern: String.raw`\b(dental nurse|nursery nurse|nursing (assistant|aide)|pharmacy (technician|assistant|dispenser)|medical (secretary|receptionist)|porter)\b`, code: "ineligible-health", onList: "no", confidence: "high" },
  { line: 31, pattern: String.raw`\b(senior care worker|care team lead)\b`, code: "6146", onList: "no", confidence: "high" },
  { line: 32, pattern: String.raw`\b(health ?care assistant|\bhca\b|care assistant|carer|care ?giver|home support|home care|support worker|care worker|personal assistant)\b`, code: "6145", onList: "no", confidence: "high" },
  { line: 33, pattern: String.raw`\b(chef|cook|commis|pastry|kitchen)\b`, code: "5434", onList: "no", confidence: "high" },
  { line: 34, pattern: String.raw`\b(hotel|restaurant|bar|food (and|&) beverage|front office|accommodation|catering) manager\b|\bpublican\b`, code: "1221", onList: "no", confidence: "high" },
  { line: 35, pattern: String.raw`\b(store|retail|shop|branch|deputy store|assistant store) manager\b`, code: "1190", onList: "no", confidence: "high" },
  { line: 36, pattern: String.raw`\b(accounts? (assistant|payable|receivable|clerk)|bookkeeper|payroll|credit controller)\b`, code: "4122", onList: "no", confidence: "high" },
  { line: 37, pattern: String.raw`\b(technician|operator|apprentice|warehouse|driver|picker|cleaner|security officer|receptionist|administrator|admin|cashier|sales assistant|customer service|call centre|(sales|customer|contact centre|call centre|support) agent|associate - fulfil|fulfil?ment)\b(?!.*\b(bim|software|database)\b)`, code: "non-cs-other", onList: "no", confidence: "high" },
  { line: 38, pattern: String.raw`\b(account executive|\bae\b|account development|sales development|business development|\bsdr\b|\bbdr\b|sales (manager|director|executive|representative|lead|specialist)|deal strategist)\b`, code: "3542?", onList: "unknown", confidence: "low" },
  { line: 39, pattern: String.raw`\b(graduate programme|graduate program|digital academy|development programme|register your interest)\b`, code: "GRAD", onList: "unknown", confidence: "low" },
  { line: 40, pattern: String.raw`\b(product (manager|owner|designer|lead)|ux|ui designer|product design)\b`, code: "AMBIG-PRODUCT", onList: "unknown", confidence: "low" },
  { line: 41, pattern: String.raw`\b(technical support|it support|service desk|help ?desk|desktop support|support analyst|onsite support)\b`, code: "3131", onList: "no", confidence: "high" },
  { line: 42, pattern: String.raw`\b(recruiter|talent acquisition|hr |human resources|people partner|marketing|communications|content|editorial|social media|customer success|account manager|partner manager|procurement|buyer|legal counsel|counsel|solicitor|lawyer|paralegal|office manager|executive assistant|operations (associate|coordinator|specialist)|logistics)\b`, code: "non-cs-other", onList: "no", confidence: "high" },
  { line: 44, pattern: String.raw`\bmidwi(fe|ves|fery)\b`, code: "2232", onList: "yes", confidence: "high" },
  { line: 45, pattern: String.raw`\b(nurse|nursing|rgn|rpn|rnid|cnm ?\d?|anp|cns)\b`, code: "2231", onList: "yes", confidence: "high" },
  { line: 46, pattern: String.raw`\b(doctor|physician|surgeon|registrar|senior house officer|\bsho\b|nchd|general practitioner|\bgp\b|anaesthetist|psychiatrist|paediatrician|radiologist|oncologist|cardiologist|geriatrician|histopathologist|consultant (in|psychiatrist|physician|surgeon|anaesthetist|radiologist|geriatrician|microbiologist)|medical officer)\b`, code: "2211", onList: "yes", confidence: "high" },
  { line: 47, pattern: String.raw`\bpharmacist\b`, code: "2213", onList: "yes", confidence: "high" },
  { line: 48, pattern: String.raw`\bpsychologist\b`, code: "2212", onList: "yes", confidence: "high" },
  { line: 49, pattern: String.raw`\b(optometrist|ophthalmic optician)\b`, code: "2214", onList: "yes", confidence: "high" },
  { line: 50, pattern: String.raw`\b(radiographer|radiation therapist|sonographer|(cardiac|vascular|respiratory|clinical|gi) physiologist|vascular technologist)\b`, code: "2217", onList: "yes", confidence: "high" },
  { line: 51, pattern: String.raw`\b(podiatrist|chiropodist)\b`, code: "2218", onList: "yes", confidence: "high" },
  { line: 52, pattern: String.raw`\b(audiologist|perfusionist|dietitian|dietician|medical scientist|biomedical scientist)\b`, code: "2219", onList: "yes", confidence: "high" },
  { line: 53, pattern: String.raw`\bphysio(therapist)?\b`, code: "2221", onList: "yes", confidence: "high" },
  { line: 54, pattern: String.raw`\boccupational therapist\b`, code: "2222", onList: "yes", confidence: "high" },
  { line: 55, pattern: String.raw`\bspeech (and|&) language\b`, code: "2223", onList: "yes", confidence: "high" },
  { line: 56, pattern: String.raw`\borthoptist\b`, code: "2229", onList: "yes", confidence: "high" },
  { line: 57, pattern: String.raw`\bsocial worker\b`, code: "2442", onList: "yes", confidence: "high" },
  { line: 58, pattern: String.raw`\bparamedic\b`, code: "3213", onList: "yes", confidence: "high" },
  { line: 59, pattern: String.raw`\b(prosthetist|orthotist)\b`, code: "3218", onList: "yes", confidence: "high" },
  { line: 61, pattern: String.raw`\b(cto|chief technology officer|head of engineering|(vp|director),? (of )?(software )?engineering|engineering director)\b`, code: "1136", onList: "yes", confidence: "high" },
  { line: 62, pattern: String.raw`\bmanager,? (\w+ )?(software|engineering|site reliability|development|data & storage reliability)|\b(technical|tech|engineering) lead\b|\b(engineering manager|software development manager|it manager|head of it|it director|manager,? software)\b`, code: "2133", onList: "yes", confidence: "high" },
  { line: 63, pattern: String.raw`\b(technical program(me)? manager|tpm|it project manager|scrum master|it programme manager)\b`, code: "2134", onList: "yes", confidence: "high" },
  { line: 64, pattern: String.raw`\b(solutions?|software|cloud|data|enterprise|security|integration|technical|systems|api|platform|network|infrastructure|salesforce|oracle|sap) architect\b`, code: "2135", onList: "yes", confidence: "high" },
  { line: 65, pattern: String.raw`\b(software|backend|back[- ]end|frontend|front[- ]end|full[- ]?stack|mobile|ios|android|web|platform|infrastructure|cloud|devops|site reliability|data|machine learning|ml|ai|firmware|embedded|java|python|\.net|c\+\+|golang|security|systems|database|test automation|qa automation|sdet|reliability|production|applied ai|forward deployed)\s+(\w+\s+)?(engineer|developer|programmer)\b|\bdeveloper\b|\bprogrammer\b|\bsde\b|\bsre\b|\bdevops\b|software development engineer|\bswe\b`, code: "2136", onList: "yes", confidence: "high" },
  { line: 66, pattern: String.raw`\b(data scientist|applied scientist|machine learning scientist|research scientist|quantitative (analyst|researcher|developer)|\bquant\b)\b`, code: "2425", onList: "yes", confidence: "high" },
  { line: 67, pattern: String.raw`\b(network engineer|security (engineer|analyst)|cyber ?security|penetration tester|cloud engineer|systems engineer|database administrator|\bdba\b|qa engineer|software test|test analyst|solutions engineer|sales engineer|data engineer|analytics engineer|bi (developer|engineer)|business intelligence)\b`, code: "2139", onList: "yes", confidence: "high" },
  { line: 69, pattern: String.raw`\b(civil|structural|site|geotechnical|highways?|water|drainage) engineer\b`, code: "2121", onList: "yes", confidence: "high" },
  { line: 70, pattern: String.raw`\bmechanical engineer\b`, code: "2122", onList: "yes", confidence: "high" },
  { line: 71, pattern: String.raw`\b(electrical|power systems?|high voltage|substation) engineer\b`, code: "2123", onList: "yes", confidence: "high" },
  { line: 72, pattern: String.raw`\b(electronics?|hardware|asic|fpga|analog|mixed[- ]signal|rf|soc|silicon|layout|verification|design verification|dv|applications?|automation|controls?|instrumentation|test) engineer\b|\b(ic|chip|circuit) design`, code: "2124", onList: "yes", confidence: "high" },
  { line: 73, pattern: String.raw`\b(design|development|validation|r ?& ?d|product|npi|packaging) engineer\b`, code: "2126", onList: "yes", confidence: "high" },
  { line: 74, pattern: String.raw`\b(process|production|manufacturing|equipment|module|lithography|yield|industrial|packaging|etch|implant|metrology|reliability) engineer\b`, code: "2127", onList: "yes", confidence: "high" },
  { line: 75, pattern: String.raw`\b(project engineer|setting[- ]out engineer|fa[cç]ade (designer|engineer)|materials? scientist)\b`, code: "2129", onList: "yes", confidence: "high" },
  { line: 76, pattern: String.raw`\b(quality (control )?engineer|supplier quality|qc engineer)\b`, code: "2461", onList: "yes", confidence: "high" },
  { line: 77, pattern: String.raw`\b(quality assurance|qa (specialist|manager|lead|associate|officer)|regulatory affairs|qualified person|validation (specialist|lead|manager))\b`, code: "2462", onList: "yes", confidence: "high" },
  { line: 78, pattern: String.raw`\b(environmental health|ehs|environmental) (officer|engineer|specialist|manager)\b`, code: "2463", onList: "yes", confidence: "low" },
  { line: 79, pattern: String.raw`\b(quantity surveyor|\bqs\b|cost manager)\b`, code: "2433", onList: "yes", confidence: "high" },
  { line: 80, pattern: String.raw`\b(land|geomatics|geospatial|measured building) surveyor\b`, code: "2434", onList: "yes", confidence: "high" },
  { line: 81, pattern: String.raw`\barchitectural (technologist|technician)\b`, code: "2435", onList: "yes", confidence: "high" },
  { line: 82, pattern: String.raw`\b(construction (project )?manager|construction planner|planner|scheduler|commercial manager)\b`, code: "2436", onList: "yes", confidence: "high" },
  { line: 83, pattern: String.raw`\bsite manager\b`, code: "1122", onList: "yes", confidence: "high" },
  { line: 84, pattern: String.raw`\bbim\b`, code: "3122", onList: "yes", confidence: "high" },
  { line: 85, pattern: String.raw`\bestimator\b`, code: "3531", onList: "yes", confidence: "high" },
  { line: 86, pattern: String.raw`\b(town planner|planning officer)\b`, code: "2432", onList: "yes", confidence: "high" },
  { line: 87, pattern: String.raw`\b(chemist|analytical scientist|qc (analyst|chemist|scientist)|quality control (analyst|chemist|scientist))\b`, code: "2111", onList: "yes", confidence: "high" },
  { line: 88, pattern: String.raw`\b(microbiologist|biologist|biochemist|bioprocess|scientist)\b`, code: "2112", onList: "yes", confidence: "low" },
  { line: 90, pattern: String.raw`\b(accountant|accounting manager|fund account\w*|tax\b|taxation|auditor|audit\b|financial controller|finance manager|head of finance|cfo|chief financial officer|aca|acca)\b`, code: "2421", onList: "yes", confidence: "high" },
  { line: 91, pattern: String.raw`\b(financial analyst|risk (analyst|manager)|credit (risk )?analyst|fraud analyst|investment analyst|fp ?& ?a|financial planning)\b`, code: "2424", onList: "yes", confidence: "high" },
  { line: 92, pattern: String.raw`\b(actuar\w+|economist|statistician)\b`, code: "2425", onList: "yes", confidence: "high" },
  { line: 93, pattern: String.raw`\b(patent|trade ?mark|intellectual property)\b`, code: "2419", onList: "yes", confidence: "high" },
  { line: 95, pattern: String.raw`\bproject manager\b|\bprogram(me)? manager\b|\bdelivery manager\b`, code: "AMBIG-PM", onList: "unknown", confidence: "low" },
  { line: 96, pattern: String.raw`\bbusiness analyst\b|\bsystems analyst\b`, code: "AMBIG-BA", onList: "unknown", confidence: "low" },
  { line: 97, pattern: String.raw`\barchitect\b`, code: "AMBIG-ARCH", onList: "unknown", confidence: "low" },
  { line: 98, pattern: String.raw`\b(consultant|analyst|specialist|engineer)\b`, code: "AMBIG-GENERIC", onList: "unknown", confidence: "low" },
  { line: 99, pattern: String.raw`\b(sales|business development|account executive)\b`, code: "3542?", onList: "unknown", confidence: "low" },
];
