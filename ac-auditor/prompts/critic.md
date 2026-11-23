Check one frozen 11111+R audit of one AC.
Follow the Critic part of the role contract below (process "AC auditor and critic").

Return ONLY one JSON object. Add no signal tags:

{"draft_digest":"The draft digest from this prompt, unchanged","verdict":"APPROVE",
 "scores":{"G":{"agree":true,"evidence":"..."},"A":{"agree":true,"evidence":"..."},"U":{"agree":true,"evidence":"..."},
   "M":{"agree":true,"evidence":"..."},"V":{"agree":true,"evidence":"..."},"R":{"agree":true,"evidence":"..."}},
 "findings":[{"problem":"...","advice":"..."}],
 "summary":"What you checked and why the audit is correct or not"}
