# Deploy meeting_prep_prototype to AWS (Lambda + S3)

This prototype has two runtime modes:


| Mode       | Frontend                                   | API                                                             | Configuration                                                                                |
| ---------- | ------------------------------------------ | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **Local**  | Vite dev server (`npm run dev`, port 5174) | Express on `127.0.0.1:3851` (proxied as `/generate`, `/health`) | `server/.env`; leave `VITE_API_BASE_URL` unset                                               |
| **Remote** | Static files on S3 (website hosting)       | AWS Lambda behind API Gateway HTTP API                          | Lambda env vars for secrets; build client with `VITE_API_BASE_URL` set to the API invoke URL |


Local development does not change after deployment: keep using `npm run dev` and `server/.env`. The UI calls the API using relative URLs when `VITE_API_BASE_URL` is empty, so the Vite proxy continues to work.

---

## Prerequisites

- An AWS account and IAM user/role with permission to create S3 buckets, Lambda functions, IAM roles, and API Gateway HTTP APIs.
- [AWS CLI v2](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) installed and configured (`aws configure`).
- Node.js 18+ locally (match the Lambda runtime you choose).

Replace placeholders in commands below:

- `REGION` — e.g. `us-east-1`
- `ACCOUNT_ID` — your 12-digit AWS account ID
- `BUCKET` — globally unique S3 bucket name for the static site
- `LAMBDA_NAME` — e.g. `meeting-prep-prototype-api`

---

## Step 1 — Package the Lambda function

From the repository root:

```bash
cd meeting_prep_prototype
npm run setup
chmod +x scripts/package-lambda.sh
npm run package:lambda
```

This creates `meeting_prep_prototype-lambda.zip` in `meeting_prep_prototype/`. It intentionally excludes `server/.env` so secrets are not uploaded.

---

## Step 2 — Create the Lambda execution role

Create a trust policy file `lambda-trust.json`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Service": "lambda.amazonaws.com" },
      "Action": "sts:AssumeRole"
    }
  ]
}
```

Create the role and attach basic logging:

```bash
aws iam create-role \
  --role-name meeting-prep-prototype-lambda-role \
  --assume-role-policy-document file://lambda-trust.json

aws iam attach-role-policy \
  --role-name meeting-prep-prototype-lambda-role \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
```

Note the role ARN (replace `ACCOUNT_ID`):

`arn:aws:iam::ACCOUNT_ID:role/meeting-prep-prototype-lambda-role`

---

## Step 3 — Create the Lambda function

Upload the zip and set the handler to `**lambda.handler**` (file `lambda.js`, exported `handler`).

```bash
cd meeting_prep_prototype

aws lambda create-function \
  --function-name LAMBDA_NAME \
  --runtime nodejs20.x \
  --architectures x86_64 \
  --role arn:aws:iam::ACCOUNT_ID:role/meeting-prep-prototype-lambda-role \
  --handler lambda.handler \
  --zip-file fileb://meeting_prep_prototype-lambda.zip \
  --timeout 120 \
  --memory-size 512 \
  --environment "Variables={OPENAI_API_KEY=your-key-here,OPENAI_MODEL=gpt-4o-mini}" \
  --region REGION
```

**OpenAI key options**

1. **Raw key in Lambda env** — set `OPENAI_API_KEY=sk-…` (quick test only).
2. **SSM Parameter Store path** — set `OPENAI_API_KEY` to the parameter **name** (must start with `/`, e.g. `/openai/meeting-prep`). At runtime the function calls `GetParameter` with decryption and uses the **stored value** as the API key. Your execution role must allow SSM read, for example attach an inline policy (replace `ACCOUNT_ID`, `REGION`, and the parameter ARN if you use a narrower resource):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["ssm:GetParameter"],
      "Resource": "arn:aws:ssm:REGION:ACCOUNT_ID:parameter/openai/*"
    }
  ]
}
```

Use a **SecureString** parameter for the secret. If it uses a **customer-managed KMS key**, the Lambda role also needs `kms:Decrypt` on that key. **Local dev:** keep a real `sk-…` key in `server/.env`; do not use an SSM path unless your machine has AWS credentials that can call `ssm:GetParameter` for that name.

### SerpAPI enrichment and cache (optional)

`/generate` calls SerpAPI (Google via `engine=google`) to enrich participants and unique companies. Set `**SERPAPI_KEY`** in Lambda environment variables (or in `server/.env` locally). If it is missing, the API still responds, but `enriched_context.enrichment_skipped_reason` explains that enrichment was skipped.

**Caching**

- **Local:** By default the server writes `server/.enrichment-cache.json` (gitignored). Override with `**ENRICHMENT_CACHE_PATH`** (absolute path recommended if you change it).
- **Lambda without DynamoDB:** If `**ENRICHMENT_CACHE_TABLE`** is unset, the app uses a **file cache under `/tmp/meeting-prep-enrichment-cache.json`** (only `/tmp` is writable; the deployment directory `/var/task` is read-only — writing next to the code caused **EROFS** in older defaults).
- **Lambda with DynamoDB (recommended for production):** Create a table with partition key `**pk`** (type **String**). Optionally enable **TTL** on numeric attribute `**ttl`** if you set `**ENRICHMENT_CACHE_TTL_SEC**`. Set `**ENRICHMENT_CACHE_TABLE**` to the table name — then the app uses DynamoDB and does not use the file cache.

Set `**ENRICHMENT_CACHE_TABLE**` when you want shared, durable cache across invocations and cold starts. When unset on Lambda, file cache still works via `/tmp` (ephemeral per execution environment).

Attach an inline policy to the Lambda role (replace `REGION`, `ACCOUNT_ID`, and table name):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["dynamodb:GetItem", "dynamodb:PutItem"],
      "Resource": "arn:aws:dynamodb:REGION:ACCOUNT_ID:table/YOUR_ENRICHMENT_TABLE"
    }
  ]
}
```

**Health check:** `GET /health` includes `serpapi_configured` and `enrichment_cache` (`"dynamo"` or `"file"`).

**Timeout:** SerpAPI adds latency (several HTTP calls per request). Keep Lambda **timeout** at least **120** seconds for meetings with multiple participants, or reduce load via cache hits.

Example environment fragment (combine with your OpenAI variables):

`SERPAPI_KEY=...`, `ENRICHMENT_CACHE_TABLE=meeting-prep-enrichment-cache`, `AWS_REGION=REGION`

To update code after changes:

```bash
npm run package:lambda
aws lambda update-function-code \
  --function-name LAMBDA_NAME \
  --zip-file fileb://meeting_prep_prototype-lambda.zip \
  --region REGION
```

---

## Step 4 — Create an HTTP API (API Gateway) and integrate Lambda

### 4a — Add Lambda permission for API Gateway

After you know the API ID (from step 4b), run `aws lambda add-permission` as shown in the AWS console wizard, or create the API first and then add permission. Example after API exists:

```bash
aws lambda add-permission \
  --function-name LAMBDA_NAME \
  --statement-id apigateway-invoke \
  --action lambda:InvokeFunction \
  --principal apigateway.amazonaws.com \
  --source-arn "arn:aws:execute-api:REGION:ACCOUNT_ID:API_ID/*/*/*" \
  --region REGION
```

(You can also attach the integration from the console; AWS often adds this permission automatically.)

### 4b — Console path (recommended for first deploy)

1. Open **API Gateway** → **Create API** → **HTTP API** → **Build**.
2. Add integration: **Lambda** → select `LAMBDA_NAME` → **Create**.
3. Configure routes:
  - `POST /generate`
  - `GET /health`
   Both should target the same Lambda integration.
4. Under **CORS**, allow your S3 website origin (or `*` for a quick test), allow **POST**, **GET**, **OPTIONS**, and headers `content-type`.
5. **Deploy** the API to stage `$default` (or `prod`).
6. Copy the **Invoke URL**, e.g. `https://abc123.execute-api.REGION.amazonaws.com` (HTTP APIs often have no stage prefix in the path).

Test:

```bash
curl -sS "https://YOUR_INVOKE_URL/health"
```

You should see JSON with `"service":"meeting_prep_prototype"`.

---

## Step 5 — Build the React client for production

Point the built SPA at your API (no trailing slash):

```bash
cd meeting_prep_prototype/client
export VITE_API_BASE_URL="https://YOUR_INVOKE_URL"
npm run build
```

Artifacts appear in `client/dist/`.

---

## Step 6 — S3 static site: what to upload and how to set permissions

### 6.1 What you upload (contents of `client/dist/`)

After **Step 5** (`npm run build` in `client/` with `VITE_API_BASE_URL` set), Vite writes a **production build** into:

`meeting_prep_prototype/client/dist/`

Upload **everything inside that folder**, preserving layout (not the `dist` directory name itself as a prefix). Typical contents:


| Path in bucket       | What it is                           |
| -------------------- | ------------------------------------ |
| `index.html`         | SPA entry; browsers load this first  |
| `assets/index-*.js`  | Bundled JavaScript (hashed filename) |
| `assets/index-*.css` | Bundled CSS (hashed filename)        |


There is **no** server code, `.env`, or `node_modules` in this bucket—only static files the browser fetches. The API stays on Lambda/API Gateway.

**CLI sync (from repo root, after build):**

```bash
aws s3 sync meeting_prep_prototype/client/dist/ s3://BUCKET/ --delete
```

`--delete` removes objects in the bucket that are no longer in `dist/` (clean redeploys). Re-run this command whenever you change the UI and rebuild.

---

### 6.2 Create the bucket

```bash
aws s3api create-bucket \
  --bucket BUCKET \
  --region REGION \
  --create-bucket-configuration LocationConstraint=REGION

# For us-east-1 omit LocationConstraint:
# aws s3api create-bucket --bucket BUCKET --region us-east-1
```

New buckets default to **Block Public Access** fully on. For a **public static website** on the S3 **website endpoint**, you must relax that and add a **bucket policy** (next subsections).

---

### 6.3 Turn off Block Public Access (only for this public-site pattern)

**AWS Console**

1. S3 → your bucket → **Permissions**.
2. **Block public access (bucket settings)** → **Edit**.
3. Uncheck **Block *all* public access**, or at minimum uncheck **Block public access to buckets and objects granted through new public bucket or access point policies** (and the related “any public bucket policy” option if shown).
4. Save and confirm.

**CLI (example: allow bucket policy to make objects public)**

```bash
aws s3api put-public-access-block \
  --bucket BUCKET \
  --block-public-acls true \
  --ignore-public-acls true \
  --block-public-policy false \
  --restrict-public-buckets false
```

Here `block-public-policy false` is what lets you attach the public read policy below. You are **not** using public ACLs on objects; the policy grants read on `BUCKET/`*.

---

### 6.4 Bucket policy: allow the world to read objects (GET)

Save as `bucket-policy.json` (replace `BUCKET` twice with your bucket name):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PublicReadGetObject",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::BUCKET/*"
    }
  ]
}
```

Apply:

```bash
aws s3api put-bucket-policy --bucket BUCKET --policy file://bucket-policy.json
```

This does **not** list the bucket contents publicly; it only allows downloading objects by key (what the website needs).

---

### 6.5 Enable static website hosting

**CLI:**

```bash
aws s3 website s3://BUCKET/ \
  --index-document index.html \
  --error-document index.html
```

**Console:** Bucket → **Properties** → **Static website hosting** → Enable → **Host a static website** → Index document `index.html`, Error document `index.html`.

Using `index.html` for **both** index and error document lets client-side routes work on refresh (the server returns the SPA shell instead of an XML error page).

---

### 6.6 Upload order (recommended)

1. Build the client (`npm run build` with `VITE_API_BASE_URL`).
2. Create the bucket.
3. Adjust Block Public Access (6.3).
4. Attach bucket policy (6.4).
5. Enable static website hosting (6.5).
6. Run `aws s3 sync … dist/ s3://BUCKET/` (6.1).

---

### 6.7 How you open the site (HTTP vs HTTPS)

- S3 **website endpoint** URL looks like  
`http://BUCKET.s3-website-REGION.amazonaws.com`  
(see **Properties → Static website hosting**). It is **HTTP only**, not HTTPS.
- For **HTTPS**, a custom domain, and caching, put **CloudFront** in front of the bucket (origin = website endpoint or REST endpoint; restrict S3 access with an **OAI/OAC** and **remove** broad public `Principal: *` if you lock the bucket down). That is the usual production setup; the steps above are the minimal “public bucket + website hosting” prototype.

---

### 6.8 Optional: Object Ownership

Default **Bucket owner enforced** is fine. You do not need object ACLs if you use only the bucket policy for public read.

---

## Step 7 — CORS on the HTTP API (required for “Generate” from S3 / CloudFront)

If the request URL is already `https://….execute-api…/generate` but the UI shows **Failed to fetch**, the browser is almost always blocking **CORS** or the **OPTIONS** preflight.

Browsers send **OPTIONS** before **POST** `/generate`. If the HTTP API has **no CORS configuration**, API Gateway often does **not** answer that preflight the way the browser expects, so `fetch` fails with **Failed to fetch** (check DevTools → **Console** for *blocked by CORS policy*).

The Lambda app also uses `cors({ origin: true })`, but **preflight may never reach Lambda** unless the API is set up for CORS. Configure CORS on the **API Gateway HTTP API** itself.

### 7.1 Find your page’s exact `Origin`

The allowed origin in API Gateway must match **exactly** what the browser sends (scheme + host + port, no path).

Examples:


| Where you open the UI | Origin to allow                                            |
| --------------------- | ---------------------------------------------------------- |
| S3 static website     | `http://BUCKET.s3-website.REGION.amazonaws.com`            |
| CloudFront            | `https://dxxxxxxxx.cloudfront.net` (or your custom domain) |


**Not** the same as the API URL. **Not** `s3.amazonaws.com` unless that is literally your address bar.

In Chrome: DevTools → **Network** → click the failed **generate** (or **OPTIONS**) request → **Request Headers** → copy **Origin**.

### 7.2 AWS Console

1. **API Gateway** → **APIs** → select your **HTTP API** (the one whose ID appears in `https://ts3ibgic7e.execute-api.…`).
2. Left menu: **CORS** (under the API, not “Resources” of a REST API).
3. **Configure** (or **Edit**).
4. **Access-Control-Allow-Origin**: add the **Origin** from §7.1 (or temporarily `*` to confirm CORS was the problem).
5. **Access-Control-Allow-Methods**: **GET**, **POST**, **OPTIONS** (and **GET** is enough for `/health`).
6. **Access-Control-Allow-Headers**: **content-type** (lowercase is fine; some UIs expect this exact header name).
7. **Save.** If your HTTP API uses `**$default`** with **auto-deploy enabled** (the usual setup), you **do not** need to open **Deploy API** afterward. CORS updates go live automatically. If the console shows **Deploy API** with `**$default` greyed out** and the text **“Auto-deploy enabled”**, that is expected: manual deploy is disabled because changes are already being published for you. Close the modal and test the browser again (hard refresh). Only APIs that use **manual** deploy need you to pick a stage and click **Deploy**.

### 7.3 AWS CLI (eu-central-1 example)

Save as `cors.json` (replace the origin with yours, or use `"*"` only for a quick test):

```json
{
  "AllowHeaders": ["content-type"],
  "AllowMethods": ["GET", "POST", "OPTIONS"],
  "AllowOrigins": ["http://YOUR-BUCKET.s3-website.eu-central-1.amazonaws.com"]
}
```

```bash
aws apigatewayv2 update-api \
  --region eu-central-1 \
  --api-id ts3ibgic7e \
  --cors-configuration file://cors.json
```

Use your real **api-id** (subdomain before `.execute-api`).

### 7.4 Quick verification

```bash
curl -sI -X OPTIONS "https://ts3ibgic7e.execute-api.eu-central-1.amazonaws.com/generate" \
  -H "Origin: http://YOUR-BUCKET.s3-website.eu-central-1.amazonaws.com" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: content-type"
```

You should see response headers such as `access-control-allow-origin` (and allow-methods / allow-headers). If **OPTIONS** returns **403** or no CORS headers, fix the HTTP API CORS settings.

### 7.5 HTTPS page + HTTP API

If the UI is served over **HTTPS** (e.g. CloudFront) and the API is **HTTPS** (`execute-api`), you are fine. Mixed-content rules only block **HTTPS pages** calling **HTTP** APIs.

---

## Local development after deployment

1. Keep `server/.env` with `OPENAI_API_KEY` and optional `MEETING_PREP_PROTOTYPE_PORT`.
2. Do **not** set `VITE_API_BASE_URL` for local dev (or leave it empty in `client/.env.development.local`).
3. Run:

```bash
cd meeting_prep_prototype
npm run dev
```

Open `http://localhost:5174`. Requests go to `/generate` on the Vite dev server, which proxies to Express on port 3851.

---

## Quick reference


| Variable                      | Where                                    | Purpose                       |
| ----------------------------- | ---------------------------------------- | ----------------------------- |
| `OPENAI_API_KEY`              | `server/.env` (local) / Lambda env (AWS) | OpenAI calls                  |
| `OPENAI_MODEL`                | same                                     | Model id                      |
| `MEETING_PREP_PROTOTYPE_PORT` | `server/.env` only                       | Local API port (default 3851) |
| `VITE_API_BASE_URL`           | **only at `npm run build` time** for S3  | Full API base URL             |


---

## Verify `VITE_API_BASE_URL` (S3 / CloudFront)

Vite **inlines** `VITE_`* variables when you run `npm run build`. They are **not** read from the browser or from S3 at runtime. If you skip them at build time, the SPA still loads from S3, but **Generate** calls `**/generate` on the same host as the page** (your bucket URL)—that request fails with **“Failed to fetch”** (or 403/404 from S3).

**Correct value**

- Your **API Gateway HTTP API invoke URL**, with **no path** and **no trailing slash**, for example:  
`https://abc123xyz.execute-api.us-east-1.amazonaws.com`
- Do **not** append `/generate`; the app adds that path.

**Set it and rebuild**

```bash
cd meeting_prep_prototype/client
export VITE_API_BASE_URL="https://YOUR_ID.execute-api.REGION.amazonaws.com"
npm run build
aws s3 sync dist/ s3://BUCKET/ --delete
```

Or create `client/.env.production` (gitignored if you add it to `.gitignore`; `client/.env.production.local` is already ignored):

```bash
# client/.env.production
VITE_API_BASE_URL=https://YOUR_ID.execute-api.REGION.amazonaws.com
```

Then `npm run build` and sync `dist/` again.

**Confirm what shipped**

1. After build, search the built JS for your invoke host:
  `grep -r "execute-api" meeting_prep_prototype/client/dist/`  
   You should see your API hostname inside `assets/index-*.js`.
2. In the browser: **DevTools → Network** → click **Generate** → check the request **URL**. It must be `https://…execute-api…/generate`, not `https://your-bucket…/generate`.

**If the URL is correct but it still fails**

- **CORS:** In API Gateway HTTP API, allow your **exact** page origin (e.g. `http://BUCKET.s3-website-REGION.amazonaws.com` or `https://dxxxx.cloudfront.net`), methods **GET, POST, OPTIONS**, header **content-type**. The console often shows *“blocked by CORS policy”* if this is wrong.
- **Mixed content:** Page served over **HTTPS** must call an **HTTPS** API URL (normal for API Gateway).

---

## Troubleshooting

- **“Failed to fetch” on Generate (S3 UI):** See **Verify `VITE_API_BASE_URL`** above; then CORS and mixed content.
- **Empty or mock briefing in AWS:** Check Lambda logs in CloudWatch; confirm `OPENAI_API_KEY` is set. If it is an SSM path (`/…`), confirm the role has `ssm:GetParameter` on that parameter’s ARN and the parameter is a **SecureString** with the real `sk-…` value.
- **CORS errors in the browser:** Fix HTTP API CORS settings and ensure the allowed origin matches the exact site URL (scheme + host + port).
- `**502` from API Gateway:** Often timeout — increase Lambda timeout (LLM calls can exceed 30s). Check CloudWatch logs for errors.
- **Wrong API hit from local UI:** Confirm you did not bake a production `VITE_API_BASE_URL` into a dev build; rebuild without it or use a fresh `npm run dev`.

