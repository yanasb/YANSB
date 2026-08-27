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
