# Privacy Policy

**Effective date:** [EFFECTIVE DATE]

This Privacy Policy explains what information clickFud ("the app," "we," "us") collects from you, how it is used, where it is stored, and what choices you have. It describes the app's **current, actual functionality** — not planned or future features.

clickFud is operated by [COMPANY NAME] and this policy is governed by the laws of [JURISDICTION]. If you have questions, contact [CONTACT EMAIL].

---

## 1. Information We Collect

### Account information
When you create an account, we collect your **name, email address, and password**. Your password is handled by our authentication provider (Supabase) and is never stored by us in readable form. You may optionally add a **phone number**, a **profile picture**, and select your **university and campus**.

### Order and collection information
When you place an order, we collect the **items and quantities** you're ordering, your **campus/collection details** (e.g. building, room, residence, campus, and any collection instructions you provide), and your **phone number** for that order. If you pay by cash on collection, we also ask for your **university student number**, which is shown to the shop's staff to confirm your identity when you collect your order.

### Payment information
If you pay by card, your payment is processed by **Paystack**, a third-party payment processor. **We never receive, see, or store your full card number, CVV, or PIN.** If Paystack indicates that your card can be safely reused, we store only: the last 4 digits of the card, the card type, the issuing bank, and the expiry date, so you can choose to reuse that card next time. Cash payments involve no card data at all.

### Location information
If you choose to use "Use my current location" or tap a "Get Directions"/"Find Directions" button, your device's GPS coordinates are used to (a) show you distance information on-screen and (b) — only at that moment, and only if you tap the button — sent as part of a link that opens Google Maps, so directions start from where you actually are. **We do not store your location.** It is held only temporarily in the app while you're using it and is cleared when you close or reload the app.

### Timetable information
If you use "My Timetable," we store the class details you enter (module name, code, class type, time, venue, campus, and any optional lecturer/notes you add), so the app can show your schedule and, if you choose, send you a reminder before class.

### Reviews and ratings
If you rate an order, we store your star rating and any comment you write, associated with your account and that order.

### Notifications
If you allow notifications, we store the technical details needed to send them to your device/browser (a push subscription endpoint and encryption keys assigned by your browser, plus your browser's user-agent string). We also keep a log of in-app notifications sent to you (e.g. "your order is ready").

### Uploaded images
If you upload a profile picture, it is stored in our file storage and is used only for your profile.

### Device/technical information
Some information is generated automatically by your browser as part of normal web/app functionality (such as the user-agent string associated with a push notification subscription). We do not currently use any separate analytics or tracking SDK.

### Local storage on your device
The app stores some information only on your own device (not sent to us), such as your theme preference (light/dark), your shopping cart contents, your favorites, and whether you've completed the app's introductory screen. This is used purely to make the app work smoothly between visits and is never transmitted anywhere by this mechanism.

### What we do NOT do
We do not use cookies. We do not use any third-party analytics, advertising, or tracking service. We do not verify your age or student status beyond the information you provide us.

---

## 2. Why We Use Your Information

We use the information above only to:
- Create and manage your account
- Let you browse shops and place orders
- Process payments and, where applicable, refunds
- Fulfil collection and confirm your identity at collection
- Provide directions via Google Maps, only when you ask for them
- Send you notifications about your order status
- Show your timetable and, where configured, remind you before class
- Maintain the security of accounts (e.g. detecting repeated failed logins)

We do not sell your personal information, and we do not use it for advertising.

---

## 3. How Information Is Stored

Your information is stored in a managed database and file storage service (Supabase). Access to your data is restricted by access-control rules so that, in general, only you (and, where relevant to fulfilling your order, the shop staff involved in that specific order) can see it. Our underlying infrastructure provider encrypts data in transit and represents that data is encrypted at rest as part of its standard service — we have not independently audited this claim beyond what our infrastructure provider documents, and recommend reviewing their current security documentation if you need further assurance.

**We do not currently have an automatic data-deletion or retention schedule.** Information you provide is retained until you request otherwise or an account-level deletion mechanism is added (see Section 6).

---

## 4. Third Parties We Share Information With

| Who | What we share | Why |
|---|---|---|
| **Supabase** (database, authentication, file storage, backend functions) | All account, order, and app data described above | Core infrastructure that runs the app |
| **Paystack** (payment processor) | Order amount, your email, and (if applicable) tokenized card details | To process card payments and refunds |
| **Google Maps** | The destination you're navigating to, and — only if you've granted location permission — your current GPS coordinate | To open directions, only at the moment you request them |
| Your browser's push notification service (e.g. the service built into Chrome or Firefox) | A subscription identifier and the notification text | To send order-status notifications to your device |
| **RecessBox**, a separate storage-booking service we also operate | Your verified email address and a short-lived sign-in token | Only if you choose to use that separate feature, so you don't have to create a second account |

We do not use any other third-party service to process your personal information at this time. If that changes, we will update this policy.

---

## 5. Cookies and Tracking

We do not use cookies. The app uses your browser's local storage only for the on-device conveniences described in Section 1 (theme, cart, favorites). This information is never transmitted to us and stays on your device.

---

## 6. Your Rights and Choices

- **Access and correction:** You can view and update your name, phone number, profile picture, university, and campus at any time from your Profile.
- **Deletion:** You can remove individual saved cards and timetable entries yourself. **We do not currently offer a self-service "delete my account" feature.** If you would like your account and associated data deleted, please contact us at [CONTACT EMAIL] and we will process your request manually.
- **Data export/access requests:** We do not currently offer a self-service data export tool. If you would like a copy of the personal information we hold about you, please contact [CONTACT EMAIL].
- **Notifications:** You can disable push notifications at any time through your browser or device settings.
- **Location:** You can decline or revoke location permission at any time through your browser or device settings; directions will still work, using a general campus location instead of your exact position.

---

## 7. Children's / Minors' Data

clickFud does not currently verify the age of anyone who creates an account. If you believe a child has provided us with personal information, please contact us at [CONTACT EMAIL] so we can address it.

---

## 8. Data Security

We rely on our infrastructure provider's access controls and security practices to protect your information, and we restrict data access within the app so that, generally, only you and the parties necessary to fulfil your specific order can see your information. No method of storage or transmission is completely secure, and we cannot guarantee absolute security.

---

## 9. Changes to This Policy

We may update this Privacy Policy from time to time to reflect changes in how the app actually works. We will update the effective date above when we do.

---

## 10. Contact

Questions about this policy or your information can be sent to [CONTACT EMAIL].

---

*This document is a draft based on the application's current implementation and should be reviewed by a qualified lawyer before publication.*
