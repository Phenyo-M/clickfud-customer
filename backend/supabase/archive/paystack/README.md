# Archived: Paystack payment functions

ClickFood moved from Paystack to PayFast on 2026-10-04. These were the
deployed Paystack Edge Functions, kept here for reference only (they are
outside `supabase/functions`, so they are never deployed again).

| Paystack function | Replaced by |
|---|---|
| paystack-initialize, paystack-group-pay | create-payfast-payment |
| paystack-webhook | payfast-itn |
| paystack-verify | payfast-status (reports only; payfast-itn confirms) |
| paystack-cancel-order | payfast-cancel-order |
| paystack-group-refund | payfast-group-refund |
| paystack-config-status | payfast-config-status |
| recessbox-paystack | recessbox-payfast |
| paystack-charge-saved | removed (saved cards switched off) |
| paystack-list-banks, paystack-manage-subaccount | removed (ClickFood pays shops itself) |

Database history is unchanged: Paystack columns (paystack_subaccount_code,
paystack_refund_reference, payment_methods, store_payout_accounts) and old
checkout_sessions rows (provider = 'paystack') are kept.
