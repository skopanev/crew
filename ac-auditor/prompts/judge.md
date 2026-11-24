Decide PASS or FAIL for one AC from the three finder results below.
Follow the Judge part of the role contract below.

Return ONLY one JSON object. Add no signal tags:

{"verdict":"PASS|FAIL|INCOMPLETE",
 "accepted":[{"criterion":"G|A|U|M|V|R","ac_quote":"exact AC text","source_quote":"exact Source or sibling text","source":"kind:id","fix":"exact text change"}],
 "rejected":[{"ac_quote":"exact text","reason":"one line"}],
 "summary":"One line: the decision"}
