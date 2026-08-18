# Company Registry Report

Generated 2026-08-18T04:24:19.715Z by `scripts/resolve-companies.ts`.

## Registry — resolved count by ATS

`scripts/companies.json` holds **74** entries total (across every phase this script has been run for).

| ATS | Count |
| --- | --- |
| ashby | 46 |
| greenhouse | 23 |
| lever | 2 |
| smartrecruiters | 1 |
| workable | 1 |
| recruitee | 1 |


## Run summary

- Companies considered this run: **42**
- Newly resolved: **32**
- Unresolved: **10**
- Dead / acquired: **0**

## Voice-AI seed accounting (Phase 5a — plans/workie.md §5a, 42 companies)

- Resolved into registry: **32**
- Unresolved: **10**
- Dead / acquired: **0**

**32 + 10 + 0 = 42** (seed list length: 42)

### Resolved

- **Vapi** — `ashby`:`vapi`
- **Bland** — `ashby`:`bland`
- **LiveKit** — `ashby`:`livekit`
- **Deepgram** — `ashby`:`deepgram`
- **Cartesia** — `ashby`:`cartesia`
- **ElevenLabs** — `ashby`:`elevenlabs`
- **AssemblyAI** — `greenhouse`:`assemblyai`
- **Rime** — `ashby`:`rime`
- **Speechmatics** — `greenhouse`:`speechmatics`
- **Hume** — `greenhouse`:`humeai`
- **Sesame** — `ashby`:`sesame`
- **Twilio** — `greenhouse`:`twilio`
- **PolyAI** — `greenhouse`:`polyai`
  - _Confirmed domain is poly.ai — polyai.com is a different, unrelated site._
- **Cresta** — `greenhouse`:`cresta`
- **Sierra** — `ashby`:`sierra`
- **Decagon** — `ashby`:`decagon`
- **Parloa** — `greenhouse`:`parloa`
- **Observe.AI** — `greenhouse`:`observeai`
  - _Not to be confused with the unrelated company "Observe Inc" (observeinc.com, IT observability), which Snowflake agreed to acquire in Jan 2026 — a different company; Observe.AI is unaffected._
- **Replicant** — `ashby`:`replicant`
- **Kustomer** — `ashby`:`kustomer`
  - _Acquired by Meta in 2020 (deal closed 2022); Meta divested it back to independent VC ownership (Battery, Redpoint, Boldstart) in May 2023. Independent again as of this run._
- **Assort Health** — `ashby`:`assorthealth`
- **Infinitus** — `ashby`:`infinitus`
- **Hello Patient** — `ashby`:`hellopatient`
- **Arini** — `ashby`:`arini`
- **Slang.ai** — `lever`:`slangai`
- **Numa** — `greenhouse`:`numa`
- **Toma** — `ashby`:`toma` (0 open postings at probe time — board confirmed, currently empty)
- **Avoca** — `ashby`:`avoca`
- **Fleetworks** — `ashby`:`fleetworks`
- **Vooma** — `ashby`:`vooma`
- **Liberate** — `greenhouse`:`liberate`
- **Salient** — `ashby`:`salient`

### Unresolved (with reason)

- **Retell** — no board found (tried 24 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee, teamtailor, pinpoint; tokens: retell, retellinc, retellai; Workday not attempted — implausible ATS for this company's size)
- **Daily** — no board found (tried 24 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee, teamtailor, pinpoint; tokens: daily, dailyinc, dailyai; Workday not attempted — implausible ATS for this company's size)
- **Krisp** — no board found (tried 24 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee, teamtailor, pinpoint; tokens: krisp, krispinc, krispai; Workday not attempted — implausible ATS for this company's size)
- **Telnyx** — no board found (tried 24 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee, teamtailor, pinpoint; tokens: telnyx, telnyxinc, telnyxai; Workday not attempted — implausible ATS for this company's size)
- **Regal** — no board found (tried 24 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee, teamtailor, pinpoint; tokens: regal, regalinc, regalai; Workday not attempted — implausible ATS for this company's size)
- **Synthflow** — no board found (tried 24 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee, teamtailor, pinpoint; tokens: synthflow, synthflowinc, synthflowai; Workday not attempted — implausible ATS for this company's size)
- **ConverseNow** — no board found (tried 24 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee, teamtailor, pinpoint; tokens: conversenow, conversenowinc, conversenowai; Workday not attempted — implausible ATS for this company's size)
- **Impel** — no board found (tried 24 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee, teamtailor, pinpoint; tokens: impel, impelinc, impelai; Workday not attempted — implausible ATS for this company's size)
- **HappyRobot** — no board found (tried 24 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee, teamtailor, pinpoint; tokens: happyrobot, happyrobotinc, happyrobotai; Workday not attempted — implausible ATS for this company's size)
- **Alex** — ambiguous token — no single voice-AI company clearly named "Alex" could be confidently identified. Candidates found: an AI interview/recruiting voice startup (Peak XV-backed, unrelated to healthcare/CS), "ALEX AI Answering Service" (alexoncall.com, generic call answering), and "Alex" used as a product/agent name inside other unrelated companies (Alivo, Alta HQ, curiousthing.io). Probing a generic "alex" token risks silently binding this registry entry to the wrong company, so it was not attempted. Needs a more specific identifier (funding round, founder, one-liner) from whoever sourced the seed list.

### Dead or acquired (with what was found)

_none_

## YC seed set

**Selection criterion:** pulled `https://yc-oss.github.io/api/companies/all.json` (a static mirror of the same Algolia index behind ycombinator.com/companies — used in place of Work at a Startup, whose /companies listing 302-redirects to a login page for unauthenticated requests and was not scraped). Filtered to `status === "Active"` and `nonprofit === false`, ranked by `isHiring` desc then launch date desc (most recent batch first), capped at 150.

- Total companies in YC directory: **6180**
- After status/nonprofit filter (the plausible pool): **4242**
- Selected (most active/recent, capped): **150**
- Skipped (in the plausible pool but past the cap): **4092**

Of the 150 selected: **22** resolved, **128** unresolved.

### Resolved

- **Ploy** — `ashby`:`ployai`
- **Miso Labs** — `ashby`:`misolabs`
- **Juno** — `greenhouse`:`juno`
- **Complir** — `ashby`:`complir`
- **OpenWork** — `greenhouse`:`openwork`
- **Clara** — `greenhouse`:`clara`
- **Dispatch** — `greenhouse`:`dispatch`
- **Superset** — `greenhouse`:`superset`
- **9 Mothers** — `ashby`:`9-mothers`
- **One Robot** — `ashby`:`onerobot`
- **Asimov** — `ashby`:`asimov`
- **Stilta** — `ashby`:`stilta`
- **General Legal** — `greenhouse`:`general`
- **Polymath** — `ashby`:`polymath`
- **Lance** — `ashby`:`lance`
- **Sparkles** — `recruitee`:`sparkles`
- **Cardboard** — `ashby`:`cardboard`
- **Human Archive** — `ashby`:`humanarchive`
- **Haladir** — `ashby`:`haladir`
- **Mantis** — `greenhouse`:`mantis`
- **DiligenceSquared** — `ashby`:`diligencesquared`
- **Moss** — `ashby`:`moss`

### Unresolved (with reason)

- **Hemlock** — no board found (tried 18 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: hemlock, hemlockinc, hemlockai; Workday not attempted — implausible ATS for this company's size)
- **Lambda Robotics** — no board found (tried 24 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: lambdarobotics, lambda-robotics, lambdaroboticsinc, lambdaroboticsai; Workday not attempted — implausible ATS for this company's size)
- **COACH** — no board found (tried 24 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: coach, coachinc, coachai, getcoach; Workday not attempted — implausible ATS for this company's size)
- **Gutgutgoose** — no board found (tried 18 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: gutgutgoose, gutgutgooseinc, gutgutgooseai; Workday not attempted — implausible ATS for this company's size)
- **Traceforce** — no board found (tried 18 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: traceforce, traceforceinc, traceforceai; Workday not attempted — implausible ATS for this company's size)
- **Ooak Data** — no board found (tried 24 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: ooakdata, ooak-data, ooakdatainc, ooakdataai; Workday not attempted — implausible ATS for this company's size)
- **Torus** — no board found (tried 24 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: torus, torusinc, torusai, usetorus; Workday not attempted — implausible ATS for this company's size)
- **Rise Reforming** — no board found (tried 24 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: risereforming, rise-reforming, risereforminginc, risereformingai; Workday not attempted — implausible ATS for this company's size)
- **screenpipe** — no board found (tried 18 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: screenpipe, screenpipeinc, screenpipeai; Workday not attempted — implausible ATS for this company's size)
- **83 Sciences** — no board found (tried 24 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: 83sciences, 83-sciences, 83sciencesinc, 83sciencesai; Workday not attempted — implausible ATS for this company's size)
- **Locke** — no board found (tried 18 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: locke, lockeinc, lockeai; Workday not attempted — implausible ATS for this company's size)
- **Operon** — no board found (tried 24 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: operon, operoninc, operonai, operonsolutions; Workday not attempted — implausible ATS for this company's size)
- **Simantic** — no board found (tried 18 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: simantic, simanticinc, simanticai; Workday not attempted — implausible ATS for this company's size)
- **Parasma** — no board found (tried 18 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: parasma, parasmainc, parasmaai; Workday not attempted — implausible ATS for this company's size)
- **Bloomy** — no board found (tried 24 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: bloomy, bloomyinc, bloomyai, bloomylearning; Workday not attempted — implausible ATS for this company's size)
- **Soria** — no board found (tried 24 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: soria, soriainc, soriaai, soriaanalytics; Workday not attempted — implausible ATS for this company's size)
- **Uno Wallet** — no board found (tried 30 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: unowallet, uno-wallet, unowalletinc, unowalletai, myunowallet; Workday not attempted — implausible ATS for this company's size)
- **River Markets** — no board found (tried 24 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: rivermarkets, river-markets, rivermarketsinc, rivermarketsai; Workday not attempted — implausible ATS for this company's size)
- **KelAI** — no board found (tried 30 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: kelai, kel, kelaiinc, kelaiai, kelaitech; Workday not attempted — implausible ATS for this company's size)
- **Arlo Industries** — no board found (tried 30 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: arloindustries, arlo-industries, arloindustriesinc, arloindustriesai, arlo1; Workday not attempted — implausible ATS for this company's size)
- **Astraea** — no board found (tried 24 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: astraea, astraeainc, astraeaai, tryastraea; Workday not attempted — implausible ATS for this company's size)
- **Aseon Labs** — no board found (tried 24 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: aseonlabs, aseon-labs, aseonlabsinc, aseonlabsai; Workday not attempted — implausible ATS for this company's size)
- **The Company Company** — no board found (tried 30 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: thecompanycompany, the-company-company, thecompanycompanyinc, thecompanycompanyai, thecompany; Workday not attempted — implausible ATS for this company's size)
- **CharacterQuilt** — no board found (tried 18 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: characterquilt, characterquiltinc, characterquiltai; Workday not attempted — implausible ATS for this company's size)
- **AgentPhone** — no board found (tried 18 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: agentphone, agentphoneinc, agentphoneai; Workday not attempted — implausible ATS for this company's size)
- **ANORIA** — no board found (tried 18 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: anoria, anoriainc, anoriaai; Workday not attempted — implausible ATS for this company's size)
- **Rudus** — no board found (tried 18 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: rudus, rudusinc, rudusai; Workday not attempted — implausible ATS for this company's size)
- **KugelAudio** — no board found (tried 18 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: kugelaudio, kugelaudioinc, kugelaudioai; Workday not attempted — implausible ATS for this company's size)
- **Hedge** — no board found (tried 24 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: hedge, hedgeinc, hedgeai, hedgespecialty; Workday not attempted — implausible ATS for this company's size)
- **Intelligence Factory** — no board found (tried 24 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: intelligencefactory, intelligence-factory, intelligencefactoryinc, intelligencefactoryai; Workday not attempted — implausible ATS for this company's size)
- **Andco** — no board found (tried 30 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: andco, and, andcoinc, andcoai, useandco; Workday not attempted — implausible ATS for this company's size)
- **Revnu** — no board found (tried 18 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: revnu, revnuinc, revnuai; Workday not attempted — implausible ATS for this company's size)
- **Huscarl** — no board found (tried 18 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: huscarl, huscarlinc, huscarlai; Workday not attempted — implausible ATS for this company's size)
- **Lightsprint** — no board found (tried 18 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: lightsprint, lightsprintinc, lightsprintai; Workday not attempted — implausible ATS for this company's size)
- **Imperfect** — no board found (tried 18 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: imperfect, imperfectinc, imperfectai; Workday not attempted — implausible ATS for this company's size)
- **Ardent** — no board found (tried 24 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: ardent, ardentinc, ardentai, tryardent; Workday not attempted — implausible ATS for this company's size)
- **Kuli** — no board found (tried 18 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: kuli, kuliinc, kuliai; Workday not attempted — implausible ATS for this company's size)
- **Klaimee** — no board found (tried 18 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: klaimee, klaimeeinc, klaimeeai; Workday not attempted — implausible ATS for this company's size)
- **Eden Robotics** — no board found (tried 24 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: edenrobotics, eden-robotics, edenroboticsinc, edenroboticsai; Workday not attempted — implausible ATS for this company's size)
- **Dayjob** — no board found (tried 24 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: dayjob, dayjobinc, dayjobai, getdayjob; Workday not attempted — implausible ATS for this company's size)
- **Nine Fives** — no board found (tried 24 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: ninefives, nine-fives, ninefivesinc, ninefivesai; Workday not attempted — implausible ATS for this company's size)
- **Tasklet** — no board found (tried 18 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: tasklet, taskletinc, taskletai; Workday not attempted — implausible ATS for this company's size)
- **Lab0** — no board found (tried 18 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: lab0, lab0inc, lab0ai; Workday not attempted — implausible ATS for this company's size)
- **Lumius** — no board found (tried 24 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: lumius, lumiusinc, lumiusai, lumius-imaging; Workday not attempted — implausible ATS for this company's size)
- **Ara** — no board found (tried 18 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: ara, arainc, araai; Workday not attempted — implausible ATS for this company's size)
- **Totalis** — no board found (tried 18 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: totalis, totalisinc, totalisai; Workday not attempted — implausible ATS for this company's size)
- **BioStack Platforms** — no board found (tried 30 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: biostackplatforms, biostack-platforms, biostackplatformsinc, biostackplatformsai, getbiostack; Workday not attempted — implausible ATS for this company's size)
- **Gojiberry AI** — no board found (tried 30 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: gojiberryai, gojiberry-ai, gojiberry, gojiberryaiinc, gojiberryaiai; Workday not attempted — implausible ATS for this company's size)
- **Runtime** — no board found (tried 24 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: runtime, runtimeinc, runtimeai, runtm; Workday not attempted — implausible ATS for this company's size)
- **Kinro** — no board found (tried 18 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: kinro, kinroinc, kinroai; Workday not attempted — implausible ATS for this company's size)
- **Discovered Materials** — no board found (tried 24 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: discoveredmaterials, discovered-materials, discoveredmaterialsinc, discoveredmaterialsai; Workday not attempted — implausible ATS for this company's size)
- **Adialante** — no board found (tried 18 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: adialante, adialanteinc, adialanteai; Workday not attempted — implausible ATS for this company's size)
- **Asendia AI** — no board found (tried 30 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: asendiaai, asendia-ai, asendia, asendiaaiinc, asendiaaiai; Workday not attempted — implausible ATS for this company's size)
- **Manicule** — no board found (tried 18 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: manicule, maniculeinc, maniculeai; Workday not attempted — implausible ATS for this company's size)
- **Hub** — no board found (tried 18 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: hub, hubinc, hubai; Workday not attempted — implausible ATS for this company's size)
- **Callab AI** — no board found (tried 30 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: callabai, callab-ai, callab, callabaiinc, callabaiai; Workday not attempted — implausible ATS for this company's size)
- **Standout** — no board found (tried 18 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: standout, standoutinc, standoutai; Workday not attempted — implausible ATS for this company's size)
- **PerfectBit, Inc.** — no board found (tried 30 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: perfectbitinc, perfectbit-inc, perfectbit, perfectbitincinc, perfectbitincai; Workday not attempted — implausible ATS for this company's size)
- **Replicas** — no board found (tried 24 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: replicas, replicasinc, replicasai, tryreplicas; Workday not attempted — implausible ATS for this company's size)
- **primitive** — no board found (tried 18 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: primitive, primitiveinc, primitiveai; Workday not attempted — implausible ATS for this company's size)
- **Arzana** — no board found (tried 18 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: arzana, arzanainc, arzanaai; Workday not attempted — implausible ATS for this company's size)
- **Ventura** — no board found (tried 18 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: ventura, venturainc, venturaai; Workday not attempted — implausible ATS for this company's size)
- **Minicor** — no board found (tried 18 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: minicor, minicorinc, minicorai; Workday not attempted — implausible ATS for this company's size)
- **General Astronautics** — no board found (tried 30 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: generalastronautics, general-astronautics, generalastronauticsinc, generalastronauticsai, generalastro; Workday not attempted — implausible ATS for this company's size)
- **Payna** — no board found (tried 18 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: payna, paynainc, paynaai; Workday not attempted — implausible ATS for this company's size)
- **Aemon** — no board found (tried 18 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: aemon, aemoninc, aemonai; Workday not attempted — implausible ATS for this company's size)
- **Revion** — no board found (tried 18 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: revion, revioninc, revionai; Workday not attempted — implausible ATS for this company's size)
- **Terranox AI** — no board found (tried 30 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: terranoxai, terranox-ai, terranox, terranoxaiinc, terranoxaiai; Workday not attempted — implausible ATS for this company's size)
- **MochaCare** — no board found (tried 18 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: mochacare, mochacareinc, mochacareai; Workday not attempted — implausible ATS for this company's size)
- **Vector Legal** — no board found (tried 24 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: vectorlegal, vector-legal, vectorlegalinc, vectorlegalai; Workday not attempted — implausible ATS for this company's size)
- **Proximitty** — no board found (tried 18 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: proximitty, proximittyinc, proximittyai; Workday not attempted — implausible ATS for this company's size)
- **CellType** — no board found (tried 18 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: celltype, celltypeinc, celltypeai; Workday not attempted — implausible ATS for this company's size)
- **Piris Labs** — no board found (tried 24 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: pirislabs, piris-labs, pirislabsinc, pirislabsai; Workday not attempted — implausible ATS for this company's size)
- **Cardinal** — no board found (tried 24 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: cardinal, cardinalinc, cardinalai, trycardinal; Workday not attempted — implausible ATS for this company's size)
- **Wayco** — no board found (tried 24 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: wayco, way, waycoinc, waycoai; Workday not attempted — implausible ATS for this company's size)
- **Robby** — no board found (tried 24 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: robby, robbyinc, robbyai, tryrobby; Workday not attempted — implausible ATS for this company's size)
- **Salus** — no board found (tried 24 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: salus, salusinc, salusai, usesalus; Workday not attempted — implausible ATS for this company's size)
- **Maywood** — no board found (tried 18 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: maywood, maywoodinc, maywoodai; Workday not attempted — implausible ATS for this company's size)
- **Sitefire** — no board found (tried 18 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: sitefire, sitefireinc, sitefireai; Workday not attempted — implausible ATS for this company's size)
- **Vela** — no board found (tried 24 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: vela, velainc, velaai, tryvela; Workday not attempted — implausible ATS for this company's size)
- **Samora AI** — no board found (tried 30 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: samoraai, samora-ai, samora, samoraaiinc, samoraaiai; Workday not attempted — implausible ATS for this company's size)
- **Fort** — no board found (tried 18 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: fort, fortinc, fortai; Workday not attempted — implausible ATS for this company's size)
- **VOYGR** — no board found (tried 18 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: voygr, voygrinc, voygrai; Workday not attempted — implausible ATS for this company's size)
- **Ruma Care** — no board found (tried 24 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: rumacare, ruma-care, rumacareinc, rumacareai; Workday not attempted — implausible ATS for this company's size)
- **Rhizome AI** — no board found (tried 30 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: rhizomeai, rhizome-ai, rhizome, rhizomeaiinc, rhizomeaiai; Workday not attempted — implausible ATS for this company's size)
- **Fenrock AI** — no board found (tried 30 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: fenrockai, fenrock-ai, fenrock, fenrockaiinc, fenrockaiai; Workday not attempted — implausible ATS for this company's size)
- **CatchBack Cards** — no board found (tried 24 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: catchbackcards, catchback-cards, catchbackcardsinc, catchbackcardsai; Workday not attempted — implausible ATS for this company's size)
- **Servo7** — no board found (tried 18 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: servo7, servo7inc, servo7ai; Workday not attempted — implausible ATS for this company's size)
- **Booko** — no board found (tried 24 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: booko, bookoinc, bookoai, bookoapp; Workday not attempted — implausible ATS for this company's size)
- **RoboDock** — no board found (tried 18 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: robodock, robodockinc, robodockai; Workday not attempted — implausible ATS for this company's size)
- **Aurorin CAD** — no board found (tried 24 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: aurorincad, aurorin-cad, aurorincadinc, aurorincadai; Workday not attempted — implausible ATS for this company's size)
- **Balance** — no board found (tried 24 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: balance, balanceinc, balanceai, getbalance; Workday not attempted — implausible ATS for this company's size)
- **Parameter (fka Hex Security)** — no board found (tried 30 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: parameterfkahexsecurity, parameter-fka-hex-security, parameterfkahexsecurityinc, parameterfkahexsecurityai, parameter; Workday not attempted — implausible ATS for this company's size)
- **Zymbly** — no board found (tried 18 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: zymbly, zymblyinc, zymblyai; Workday not attempted — implausible ATS for this company's size)
- **Jinba** — no board found (tried 18 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: jinba, jinbainc, jinbaai; Workday not attempted — implausible ATS for this company's size)
- **Cumulus Labs** — no board found (tried 24 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: cumuluslabs, cumulus-labs, cumuluslabsinc, cumuluslabsai; Workday not attempted — implausible ATS for this company's size)
- **Seeing Systems** — no board found (tried 24 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: seeingsystems, seeing-systems, seeingsystemsinc, seeingsystemsai; Workday not attempted — implausible ATS for this company's size)
- **10x Science** — no board found (tried 24 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: 10xscience, 10x-science, 10xscienceinc, 10xscienceai; Workday not attempted — implausible ATS for this company's size)
- **Moritz** — no board found (tried 24 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: moritz, moritzinc, moritzai, moritzlegal; Workday not attempted — implausible ATS for this company's size)
- **Galactic Resource Utilization Space, Inc. (GRU Space)** — no board found (tried 30 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: galacticresourceutilizationspaceincgruspace, galactic-resource-utilization-space-inc-gru-space, galacticresourceutilizationspaceincgruspaceinc, galacticresourceutilizationspaceincgruspaceai, gru; Workday not attempted — implausible ATS for this company's size)
- **RamAIn** — no board found (tried 18 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: ramain, ramaininc, ramainai; Workday not attempted — implausible ATS for this company's size)
- **RunAnywhere** — no board found (tried 18 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: runanywhere, runanywhereinc, runanywhereai; Workday not attempted — implausible ATS for this company's size)
- **Voltair** — no board found (tried 24 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: voltair, voltairinc, voltairai, voltairlabs; Workday not attempted — implausible ATS for this company's size)
- **AutoSitu** — no board found (tried 18 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: autositu, autosituinc, autosituai; Workday not attempted — implausible ATS for this company's size)
- **Chasi** — no board found (tried 18 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: chasi, chasiinc, chasiai; Workday not attempted — implausible ATS for this company's size)
- **Pocket** — no board found (tried 24 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: pocket, pocketinc, pocketai, heypocket; Workday not attempted — implausible ATS for this company's size)
- **Autonomous Technologies Group** — no board found (tried 30 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: autonomoustechnologiesgroup, autonomous-technologies-group, autonomoustechnologiesgroupinc, autonomoustechnologiesgroupai, becomeautonomous; Workday not attempted — implausible ATS for this company's size)
- **Fifth Door** — no board found (tried 24 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: fifthdoor, fifth-door, fifthdoorinc, fifthdoorai; Workday not attempted — implausible ATS for this company's size)
- **AtlasGrid** — no board found (tried 18 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: atlasgrid, atlasgridinc, atlasgridai; Workday not attempted — implausible ATS for this company's size)
- **F2** — no board found (tried 18 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: f2, f2inc, f2ai; Workday not attempted — implausible ATS for this company's size)
- **Exonic** — no board found (tried 18 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: exonic, exonicinc, exonicai; Workday not attempted — implausible ATS for this company's size)
- **Thesis** — no board found (tried 24 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: thesis, thesisinc, thesisai, thesislabs; Workday not attempted — implausible ATS for this company's size)
- **Zarna** — no board found (tried 18 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: zarna, zarnainc, zarnaai; Workday not attempted — implausible ATS for this company's size)
- **Nessie** — no board found (tried 24 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: nessie, nessieinc, nessieai, nessielabs; Workday not attempted — implausible ATS for this company's size)
- **Jarmin** — no board found (tried 18 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: jarmin, jarmininc, jarminai; Workday not attempted — implausible ATS for this company's size)
- **Digipals** — no board found (tried 18 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: digipals, digipalsinc, digipalsai; Workday not attempted — implausible ATS for this company's size)
- **item** — no board found (tried 18 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: item, iteminc, itemai; Workday not attempted — implausible ATS for this company's size)
- **Scott AI** — no board found (tried 36 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: scottai, scott-ai, scott, scottaiinc, scottaiai, tryscott; Workday not attempted — implausible ATS for this company's size)
- **Sava** — no board found (tried 24 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: sava, savainc, savaai, savahq; Workday not attempted — implausible ATS for this company's size)
- **Brickwise** — no board found (tried 18 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: brickwise, brickwiseinc, brickwiseai; Workday not attempted — implausible ATS for this company's size)
- **The Hog** — no board found (tried 24 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: thehog, the-hog, thehoginc, thehogai; Workday not attempted — implausible ATS for this company's size)
- **Overdrive Health** — no board found (tried 30 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: overdrivehealth, overdrive-health, overdrivehealthinc, overdrivehealthai, overdrive; Workday not attempted — implausible ATS for this company's size)
- **Karumi** — no board found (tried 18 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: karumi, karumiinc, karumiai; Workday not attempted — implausible ATS for this company's size)
- **Lemma** — no board found (tried 24 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: lemma, lemmainc, lemmaai, uselemma; Workday not attempted — implausible ATS for this company's size)
- **Aspect** — no board found (tried 18 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: aspect, aspectinc, aspectai; Workday not attempted — implausible ATS for this company's size)
- **Rovi Health** — no board found (tried 30 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: rovihealth, rovi-health, rovihealthinc, rovihealthai, rovi; Workday not attempted — implausible ATS for this company's size)
- **Lightberry** — no board found (tried 18 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: lightberry, lightberryinc, lightberryai; Workday not attempted — implausible ATS for this company's size)
- **Velvet** — no board found (tried 24 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: velvet, velvetinc, velvetai, velvetlab; Workday not attempted — implausible ATS for this company's size)

## AI-startup seed set (modest, best-effort)

Of 18 candidates: **15** resolved, **3** unresolved.

### Resolved

- **Anthropic** — `greenhouse`:`anthropic`
- **OpenAI** — `ashby`:`openai`
- **Perplexity** — `ashby`:`perplexity`
- **Together AI** — `greenhouse`:`togetherai`
- **Modal** — `ashby`:`modal`
- **Runway** — `ashby`:`runway`
- **Pinecone** — `ashby`:`pinecone`
- **Scale AI** — `greenhouse`:`scaleai`
- **Hugging Face** — `workable`:`huggingface`
- **Cohere** — `ashby`:`cohere`
- **Glean** — `smartrecruiters`:`glean`
- **Harvey** — `ashby`:`harvey`
- **Baseten** — `ashby`:`baseten`
- **LangChain** — `ashby`:`langchain`
- **Fireworks AI** — `ashby`:`fireworks`

### Unresolved (with reason)

- **Mistral AI** — no board found (tried 30 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: mistralai, mistral-ai, mistral, mistralaiinc, mistralaiai; Workday not attempted — implausible ATS for this company's size)
- **Replicate** — no board found (tried 18 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: replicate, replicateinc, replicateai; Workday not attempted — implausible ATS for this company's size)
- **Weights & Biases** — no board found (tried 30 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: weightsbiases, weights-biases, weightsbiasesinc, weightsbiasesai, wandb; Workday not attempted — implausible ATS for this company's size)

## Design/game studio seed set (modest, best-effort)

Of 10 candidates: **5** resolved, **5** unresolved. Teamtailor is out of scope for this phase's resolver (plan defers it), so a studio that only publishes through Teamtailor shows here as unresolved, not a bug.

### Resolved

- **IDEO** — `greenhouse`:`ideo`
- **MetaLab** — `greenhouse`:`metalab`
- **Fantasy** — `lever`:`fantasy`
- **Supercell** — `ashby`:`supercell`
- **Riot Games** — `greenhouse`:`riotgames`

### Unresolved (with reason)

- **Pentagram** — no board found (tried 18 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: pentagram, pentagraminc, pentagramai; Workday not attempted — implausible ATS for this company's size)
- **Ustwo** — no board found (tried 18 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: ustwo, ustwoinc, ustwoai; Workday not attempted — implausible ATS for this company's size)
- **Frog** — no board found (tried 24 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: frog, froginc, frogai, frogdesign; Workday not attempted — implausible ATS for this company's size)
- **Double Fine** — no board found (tried 24 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: doublefine, double-fine, doublefineinc, doublefineai; Workday not attempted — implausible ATS for this company's size)
- **Klei** — no board found (tried 18 probes across greenhouse, ashby, lever, workable, smartrecruiters, recruitee; tokens: klei, kleiinc, kleiai; Workday not attempted — implausible ATS for this company's size)

## Methodology

- A candidate (ats, token) pair counts as **confirmed** per a per-ATS rule (see `scripts/ats-probe.js`): greenhouse/lever/ashby/recruitee/teamtailor/pinpoint 404 an unknown token, so any HTTP 200 with the right shape confirms the token even at zero current postings; workable/smartrecruiters/workday return 200 + an empty shell for tokens that don't exist at all, so those three still require a non-empty array.
- Candidate tokens: lowercase-no-punctuation slug, hyphenated slug, both with common suffixes (inc/llc/co/corp/ltd/ai) stripped, and the domain stem of any known website — deduped, capped at 6 per company.
- Rate limit: max 2 requests/second per host, enforced by a shared per-host throttle in `scripts/ats-probe.js`; different ATS hosts run concurrently.
- Workday discovery (tenant × wd1/wd3/wd5/wd103 × site-name guesses) is opt-in per company and was only attempted where there's an actual reason to expect a large/established employer (Twilio, Riot Games) — running it blindly against every small startup in the seed sets would multiply request volume for near-zero plausible yield, since Workday targets enterprise HR, not 20-person startups. Everyone else's "no board found" reason notes Workday was not attempted, not that it was tried and failed.
- Teamtailor and Pinpoint are confirmed-probeable (verified against real tenants: recruitgo.teamtailor.com, workwithus.pinpointhq.com) but not in the default sweep — plans/workie.md's rule is "add them when the registry actually has a company on one, not before." Rippling and BambooHR remain unconfirmed: Rippling's documented Job Board API is gated behind a paid subscription and its public page renders job data client-side with no stable JSON surface found; BambooHR's only public surface is, per multiple independent sources, an undocumented internal endpoint that changes shape/host between releases, and no real customer example could be found to verify against. Both are skipped rather than guessed, same standard as everything else in this phase.
- Every registry write carries `verified_at` set to the moment of that successful probe, and `postings_at_probe` recording the exact count seen (0 is valid and meaningful — it means a real, confirmed board with no current openings, not "not found").
