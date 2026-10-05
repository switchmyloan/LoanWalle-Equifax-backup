# Sending a lead from your application server

Your server calls **one HTTP endpoint** on this service. It never talks to
ClickHouse, never holds database credentials, and never knows a table name.

    POST http://<this-server>:4010/api/leads
    X-API-Key: <INGEST_API_KEY>
    Content-Type: application/json

    {"pan":"CAAPB5467N","partnerName":"Tejas","mobile":"9999900000","name":"Bharat","utmSource":"loanwalle"}

    201 -> {"ok":true,"count":1,"leads":[{"pan":"CAAPB5467N","partnerName":"Tejas"}]}

Call it when the user clicks a lender card. That is the whole integration - the
cron picks the lead up on its next run and starts polling the partner.

## Fields

| Field | Required | Notes |
|---|---|---|
| `pan` | yes | any case, spaces trimmed; validated as `ABCDE1234F` |
| `partnerName` | yes | `Tejas` or `F1`, any case |
| `mobile` | no | `+91 99999-00000`, `09999900000`, `919999900000` all normalize to 10 digits |
| `name`, `email`, `utmSource` | no | |

The endpoint normalizes so that ' caapb5467n ' and 'CAAPB5467N' are the same
user - `loanwalle_users` is keyed on `pan`, and an unnormalized value would be
polled as a second lead.

## Idempotent by design

Posting the same PAN again updates the user instead of duplicating them, so:

- retries after a network error are free
- the click handler can fire twice without consequence
- you can enrich later - post the lead again with `mobile`/`name` filled in

## Errors

| Status | Meaning |
|---|---|
| 400 | validation failed - `errors` lists every problem, e.g. `["pan 'NOTAPAN' is not a valid PAN (expected ABCDE1234F)"]` |
| 401 | missing or wrong `X-API-Key` |
| 409 | the PAN is already registered with a different partner - see below |
| 413 | more than `MAX_BATCH` (200) leads in one request |
| 500 | our side - safe to retry |

A batch is all-or-nothing: one bad row rejects the request, so you never have to
reconcile a partial write.

## One lender per user

A PAN belongs to exactly one partner. Re-posting the same PAN with the SAME
partner is fine - that is how retries and enrichment work. Re-posting it with a
DIFFERENT partner is refused:

    409 {"ok":false,"error":"PAN already registered with a different partner",
         "conflicts":[{"pan":"CAAPB5467N","existingPartner":"Tejas",
                       "requestedPartner":"F1","source":"existing lead"}]}

Without this, the lead would silently move to the other lender while the status
already collected for the first one stayed behind in loanwalle_latest, and the
cron would start polling the new partner with the old history behind it.

`source` says where the clash came from: `existing lead` (already in the
database) or `this request` (the batch contradicts itself).

To move a lead deliberately, delete the user row first - it is not something the
API will do implicitly.

## Batch

    POST /api/leads
    [{"pan":"AAAPB1111A","partnerName":"Tejas"},{"pan":"BBBPB2222B","partnerName":"F1"}]

or `{"leads":[...]}`. Prefer this over a request per row if you ever import in bulk.

## Reading a status back

    GET /api/leads/CAAPB5467N
    X-API-Key: <INGEST_API_KEY>

    {"ok":true,"pan":"CAAPB5467N","partnerName":"Tejas","status":"DUPLICATE",
     "finalStatus":"LEAD_ALREADY_EXIST_WITH_PARTNER","isFinal":true,
     "loanAmount":null,"disbursedAmount":null,"disbursedDate":null,
     "lastCheckedAt":"2026-08-25 18:45:30.037"}

`status` is the normalized bucket; `finalStatus` is the partner's own wording.
`"status":"PENDING"` means the lead is queued but has not been checked yet -
which is not the same as the partner replying `NOT_FOUND`. 404 means no lead
exists for that PAN.

## Node.js client

    async function saveLeadClick(lead) {
      const res = await fetch(`${process.env.LOANWALLE_API}/api/leads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': process.env.LOANWALLE_API_KEY },
        body: JSON.stringify(lead),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(`lead rejected: ${JSON.stringify(body.errors || body.error)}`);
      return body;
    }

## PHP

    $ch = curl_init(getenv('LOANWALLE_API') . '/api/leads');
    curl_setopt_array($ch, [
      CURLOPT_POST => true,
      CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'X-API-Key: ' . getenv('LOANWALLE_API_KEY')],
      CURLOPT_POSTFIELDS => json_encode(['pan' => $pan, 'partnerName' => $partner, 'mobile' => $mobile]),
      CURLOPT_RETURNTRANSFER => true,
    ]);
    $body = json_decode(curl_exec($ch), true);

## Python

    import os, requests
    def save_lead_click(**lead):
        r = requests.post(f"{os.environ['LOANWALLE_API']}/api/leads",
                          json=lead,
                          headers={'X-API-Key': os.environ['LOANWALLE_API_KEY']},
                          timeout=10)
        r.raise_for_status()
        return r.json()

## Deployment note

The service listens on `PORT` (4010) and speaks plain HTTP. Do not expose that
port publicly - put it behind nginx with TLS, or keep it on the private network
between your app server and this one. The `X-API-Key` is a bearer secret: over
plain HTTP on a public network it is readable in transit.
