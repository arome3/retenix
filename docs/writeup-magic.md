# Magic — Retenix

**Retenix is a self-custodial brokerage that runs itself.** Magic is its trust anchor: the thing that
makes "self-custodial" a property a user can verify rather than a word in our copy.

An investment product asks for more trust than almost anything else in consumer crypto. Ours asks for
even more, because an agent acts on your behalf while you are not looking. Every part of that
argument bottoms out in one question — *whose key is it?* — and Magic is how we answer it without
asking anyone to write down twelve words.

---

## 1. Onboarding: email, and nothing else

Email OTP to a funded, investing account. No seed phrase, no extension, no "connect wallet," no
network to pick. The phrase *seed phrase* does not appear anywhere in the product, and neither does
*wallet* — both are on a banned-vocabulary list that a CI job enforces against every user-facing
string.

**Measured: 18.1 seconds** from email submit to the ready screen, against a 60-second budget — a real
login, a real inbox, timed off two server-clock event rows rather than a stopwatch.

### We replaced Magic's hosted OTP window, and it was the right call

Magic's modal works, but it is Magic's chrome appearing in the middle of Retenix's most
trust-sensitive moment. We run `loginWithEmailOTP({ email, showUI: false })` and collect the code in
our own interface — one monospace field, so paste and iOS one-time-code autofill both work, and a
screen reader gets a single labelled input rather than six.

The event wiring is the whole feature: `email-otp-sent` → show the input;
`emit("verify-email-otp", code)` → `invalid-email-otp` is a *retry*, not a failure;
`expired-email-otp` / `max-attempts-reached` / `login-throttled` are terminal and route to a resend.
New-device approval stays Magic's interstitial deliberately — that is a security decision, and it
should look like one.

There is a **self-healing fallback**: an attempt that dies before `email-otp-sent` retries once with
`showUI: true`. A plan change or a dashboard setting can therefore never brick login. Verified live
against Magic's servers, including the wrong-code round trip, with the Magic iframe confirmed
`display:none` throughout.

---

## 2. Headless signing: the part users never see, which is the point

Retenix needs three different signatures, and none of them may open a popup:

| What | Magic API | Why it has to be headless |
|---|---|---|
| UA root hash | `magic.rpcProvider.request({ method: "personal_sign", … })` | plain `personal_sign`, never typed data — what the Universal Accounts SDK expects |
| EIP-7702 authorization | `magic.wallet.sign7702Authorization({ contractAddress, chainId })` | upgrades the user's own EOA in place; also the escrowed inheritance tuple |
| Network selection for reads | `magic.evm.switchChain(chainId)` | must precede a 7702 signature, since Magic fetches the account nonce from the selected endpoint |

This is what makes **"one confirmation, N headless signatures"** possible — the pattern the whole
product is built on. A user taps *Sweep* once; underneath, balances on five networks are consolidated
with as many signatures as the SDK needs. They confirm an *intention*, not a transaction batch. Every
place a normal crypto app would show its fourth "sign this" modal, Retenix shows nothing, because the
user already said yes to the thing they actually care about.

**Proven on mainnet, not testnet.** Magic's documentation demonstrates 7702 on Sepolia. We treated
Arbitrum One as a blocking week-1 gate, and verified the returned tuple independently with ethers
rather than trusting it by eye: `recoverAddress(hashAuthorization({address, chainId: 42161, nonce}),
sig)` returns the session EOA. `Signature.from({v,r,s}).serialized` matches the 65-byte value.

Two integration notes worth passing on, both of which cost us time:
`magic.user.getInfo()` has **no top-level `publicAddress`** in the current types — it is at
`wallets.ethereum.publicAddress`, and you should not trust it anyway (the address we trust comes from
the server's DID verification). And `revealPrivateKey()` returns `void`; the one you want is
**`revealEVMPrivateKey()`**.

---

## 3. Key export: the proof, not a setting

Profile → **Export your key** opens Magic's own reveal flow. The key material never touches a Retenix
server, a Retenix log, or a Retenix host — verifiable in the browser's network tab, which is the
point of doing it this way rather than building our own reveal screen.

This is the closing line of our demo, and it is deliberately the last thing a judge sees:

> **"It's your address. It always was."**

Everything upstream depends on it being true. The agent's authority is capped onchain — but caps only
matter if the account is genuinely yours. The kill switch moves everything to USDC "in your own
balance" — only meaningful if that balance is yours to walk away with. Inheritance transfers *your*
address to your heir, not a custodial position. Key export is what converts each of those from a
promise into a checkable fact.

We handle its failure path carefully: the rejection is **never inspected and never logged**. A
printed rejection is the one place key material could plausibly leak, so the code declines to look.

---

## 4. Heir onboarding: the flow Magic makes possible at all

Consider what inheritance normally demands of a beneficiary. Install something. Understand a seed
phrase. Do it correctly, once, under emotional load, having never used crypto — because the person
who *did* use crypto is the reason they are here.

Retenix's heir flow is: an email arrives → click → **email OTP** → *"You've inherited $4,812 across 5
sources"* → one tap. Magic makes the heir's own account in the same motion. No prior crypto
experience, no software installed, nothing to write down at the worst possible moment.

The heir surface uses the gentlest vocabulary in the product — *account*, *confirm*, *sources* —
because the person reading it may be doing so on the worst day of their year. It is also forced to
the light theme, deliberately: this screen should not feel like a trading terminal.

There are ~$121B sitting in decade-dormant Bitcoin alone. The blocker was never the cryptography. It
was that inheritance required the *recipient* to become a crypto user first.

---

## The honest trust gradient

**What Magic guarantees.** Keys are generated and held in Magic's TEE; Retenix never has them. Export
proves this at any moment. Signing happens without us ever seeing key material.

**What you are trusting when you use Magic.** Magic's infrastructure holds the key custody
architecture, and your email account is the recovery path — so email account takeover is the realistic
threat, not cryptography. We mitigate what we can at our layer: every high-impact action carries
confirmation friction, and Magic's 2FA options are enabled on the account. But we would rather write
this sentence than imply email login is equivalent to a hardware wallet. **It is not.** It is
dramatically better than the alternative that actually competes with it, which is not a hardware
wallet — it is no self-custody at all, because the seed phrase lost the user at step one.

**The one deliberate exception.** The kill switch is intentionally *low*-friction: no confirmation
gauntlet, a 1.5-second hold and it goes. Every other high-impact action gets friction; this one gets
the opposite, because it only ever moves your assets to USDC **in your own account** and revokes
agent authority. The worst case of an accidental kill switch is an unwanted sell. The worst case of a
kill switch that was too hard to reach, at the moment someone needed it, is the reason people distrust
agents at all.

**Where the seam still shows.** Magic holds EVM keys; Solana is reached through the Universal Accounts
layer. Estate coverage is therefore EVM-only today, and we say so on the enrollment screen rather than
letting someone assume their Solana equities are covered.

---

## Why this stack, together

Magic and Particle are complementary rather than overlapping, and the split is clean:

- **Magic** owns identity and the key — email in, EOA out, headless signatures, exportable at will.
- **Particle** owns the balance and the movement — one balance across six networks, in 7702 mode, on
  the address Magic gave the user.
- **Arbitrum** owns the rules — caps, allowlists, revocation, and the estate state machine.

Each layer is checkable independently. That is the actual argument for consumer trust in an agentic
product: not "trust us," but three separate things a suspicious person can verify without asking us
anything.

---

*Retenix — Arnen Labs. Six networks: Ethereum, Base, Arbitrum, BSC, X Layer, Solana.*
