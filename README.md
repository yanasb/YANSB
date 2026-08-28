# Palm Treasure — Production USDT Deposit Backend

هذا المشروع مسؤول عن معالجة تعبئة USDT باستخدام NOWPayments.

## Architecture

Frontend
↓
Authenticated JWT
↓
Backend API
↓
NOWPayments
↓
Blockchain
↓
NOWPayments IPN
↓
IPN signature verification
↓
Payment verification
↓
Atomic PostgreSQL transaction
↓
User balance
↓
Transaction record
↓
Deposit history

## Authentication

النظام يوفر تسجيل دخول ومستخدمين مبنيًا داخل نفس `api/server.js` (بدون أي اعتماد خارجي):

```text
POST /api/auth/register   { username, password, email? } → { token, user }
POST /api/auth/login      { username, password }         → { token, user }
GET  /api/auth/me         (Bearer token)                 → { id, username, email, balance }
```

- كلمات المرور تُخزَّن مُشفّرة فقط عبر bcrypt (لا يوجد نص صريح أبدًا في قاعدة البيانات).
- اسم المستخدم: أحرف إنجليزية صغيرة وأرقام و`_` فقط، من 3 إلى 32 محرفًا.
- كلمة المرور: 8 أحرف على الأقل.
- عند نجاح التسجيل أو الدخول، يُصدر السيرفر JWT موقّع بـ`JWT_SECRET` صالح لمدة 30 يومًا، ويُستخدم هذا التوكن في `Authorization: Bearer <token>` لكل الطلبات المحمية (الرصيد، الإيداعات).
- Frontend يخزّن التوكن في `localStorage` فقط بعد استلامه من الباك-إند مباشرة، ولا يولّده أو يعدّله بنفسه.

## Security

الرصيد لا يتم تعديله من Frontend.

لا توجد أي API تسمح للواجهة بإرسال:

- addBalance
- confirmPayment
- trusted balance
- trusted txHash

لتعديل الرصيد.

الرصيد تتم إضافته فقط من Backend بعد:

1. IPN signature verification
2. payment_id verification
3. user/deposit matching
4. currency verification
5. network verification
6. destination address verification
7. payment status verification
8. positive actually_paid
9. duplicate payment prevention
10. transaction hash uniqueness
11. PostgreSQL transaction

## Deposit statuses

يستخدم النظام الحالات التالية فقط:

- waiting
- confirming
- finished
- failed
- expired

NOWPayments قد ترسل حالات إضافية مثل:

- confirmed
- sending
- partially_paid
- refunded

ويتم تحويلها داخليًا إلى الحالات المناسبة.

لا يتم إضافة الرصيد إلا عند:

`payment_status = finished`

## Permanent Deposit Addresses

المشروع لا ينشئ عناوين Blockchain محليًا.

المشروع لا يخترع عناوين.

المشروع لا يستخدم عنوانًا واحدًا لكل المستخدمين.

المشروع لا يعتبر عنوان NOWPayments العادي عنوانًا دائمًا تلقائيًا.

يجب أن تكون ميزة Permanent Deposit Addresses مؤكدة ومفعلة من NOWPayments لحساب التاجر.

إذا لم تكن الميزة مفعلة، فإن API يعيد:

`503`

مع رسالة واضحة.

لا يتم إنشاء عنوان مزيف.

## Environment Variables

يجب وضع Secrets في Render Environment Variables فقط.

المتغيرات:

```text
NOWPAYMENTS_API_KEY
NOWPAYMENTS_IPN_SECRET
NOWPAYMENTS_IPN_CALLBACK_URL
BASE_URL
JWT_SECRET
DATABASE_URL
```

راجع `api/.env.example` لشرح كل متغير. لا يتم وضع أي Secret داخل `web/` أو GitHub، فقط داخل Render Environment Variables.

## Render PostgreSQL

1. من لوحة Render، أنشئ (أو استخدم) قاعدة PostgreSQL في منطقة Virginia (نفس منطقة الـ Web Service).
2. من صفحة القاعدة، انسخ **Internal Database URL** (وليس External) لأن الـ Backend يعمل داخل نفس شبكة Render.
3. ضع هذه القيمة في متغير `DATABASE_URL` الخاص بالـ Web Service.
4. لا حاجة لإنشاء الجداول يدويًا؛ عند إقلاع السيرفر تقوم دالة `initializeDatabase()` في `api/server.js` بإنشاء الجداول التالية تلقائيًا إن لم تكن موجودة:
   - `users`
   - `deposit_addresses`
   - `deposits`
   - `transactions`
   مع الفهارس (indexes) والقيود (constraints) المطلوبة لمنع التكرار (unique payment_id، unique tx_hash، unique address).

## Render Web Service

الإعداد الحالي (كما هو، لم يتغير):

```text
Repository: yanasb/YANSB
Branch: main
Language: Node.js
Region: Virginia (US East)
Root Directory: api
Build Command: npm install
Start Command: npm start
```

تأكد قبل الضغط على Deploy النهائي من ضبط جميع Environment Variables المذكورة أعلاه في إعدادات الـ Web Service، وأن قاعدة PostgreSQL في نفس المنطقة (Virginia) متصلة عبر `DATABASE_URL`.

## طريقة تشغيل المشروع محليًا

```bash
cd api
cp .env.example .env
# عدّل القيم داخل .env محليًا (لا يتم رفعه إلى GitHub)
npm install
npm start
```

السيرفر يستمع على المنفذ المحدد في `PORT` (افتراضيًا 3000)، ويطبع في اللوغ حالة `BASE_URL` وحالة تفعيل Permanent Deposit Addresses.

## اختبار Health API

بعد تشغيل السيرفر (محليًا أو على Render):

```bash
curl https://YOUR-SERVICE.onrender.com/api/health
```

الاستجابة تحتوي على:

- `ok`: `true` فقط إذا كانت جميع الإعدادات موجودة وقاعدة البيانات متصلة.
- `database`: `ok` أو `error`.
- `nowpayments` و`ipn`: `configured` أو `missing`.
- `permanentDepositAddresses`: `enabled` أو `disabled`.
- `supportedNetworks`: قائمة الشبكات المفعّلة فعليًا فقط.

إذا كانت `ok: false`، راجع Environment Variables الناقصة قبل المتابعة.

## تدفق Deposit الكامل

```text
تسجيل الدخول (نظام المستخدمين الحالي)
  ↓
صفحة Recharge → اختيار USDT + Network + Amount
  ↓
Frontend يطلب عنوان الإيداع: GET /api/me/deposit-address
  ↓
Backend يتحقق: هل Permanent Deposit Addresses مفعّلة فعليًا؟
  ├─ لا → 503 + رسالة واضحة (لا يُنشأ أي عنوان وهمي/مشترك)
  └─ نعم → إرجاع العنوان الحقيقي الخاص بالمستخدم + QR (GET /api/me/deposit-qr)
  ↓
Frontend يرسل: POST /api/deposits/create { currency, amount }
  ↓
Backend ينشئ سجل Deposit بحالة waiting (لا تعديل رصيد هنا إطلاقًا)
  ↓
المستخدم يرسل USDT إلى العنوان الحقيقي عبر الشبكة الصحيحة
  ↓
Blockchain → NOWPayments → POST /api/deposits/ipn
  ↓
1) التحقق من x-nowpayments-sig (HMAC-SHA512)
2) إعادة جلب الدفعة مباشرة من NOWPayments API عبر GET /v1/payment/{payment_id}
   (لا يُعتمد على بيانات IPN وحدها إطلاقًا)
3) مطابقة الـ deposit المرتبط بالمستخدم
4) التحقق من العملة/الشبكة/العنوان المطابقة لطلب الإيداع
5) التحقق من عدم استخدام نفس payment_id أو tx_hash لإيداع آخر (Idempotency)
6) فقط عند status = finished ومبلغ actually_paid > 0:
   PostgreSQL transaction: تحديث Deposit + إضافة الرصيد + تسجيل Transaction ثم COMMIT
  ↓
GET /api/deposits/:id → يعرض للمستخدم الحالة النهائية finished
```

أي IPN مكرر لنفس `payment_id` لا يضيف رصيدًا مرة ثانية ولا ينشئ Transaction جديدة، لأن التحديث النهائي مشروط بـ`credited_amount = 0` داخل نفس صف مُقفل (`SELECT ... FOR UPDATE`).
