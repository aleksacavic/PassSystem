// Guest-facing language support (registration and pass pages): English and Arabic.
// Staff pages stay in English. The choice is remembered on the device.
import { createContext, useContext } from 'react'

export type Lang = 'en' | 'ar'

export const STORAGE_KEY = 'passsystem.lang'

const en = {
  'lang.switch': 'العربية',
  'lang.switchLabel': 'عرض الصفحة بالعربية',
  loading: 'Loading…',
  tryAgain: 'Try again',
  optional: 'Optional',
  'event.notFound': 'Event not found',
  'event.notFoundBody': 'Check that the link is correct. The event may not be published yet.',
  'event.error': 'Something went wrong',
  'event.open': 'Registration open',
  'event.draft': 'Preview: this event is a draft and only staff can see it. Publish it to open registration.',
  'event.existing': 'You already have a pass on this device',
  'event.viewPass': 'View pass for {name}',
  'event.registerAnother': 'You can still register another person below.',
  'event.notOpen': 'Registration has not opened yet',
  'event.opensAt': 'Registration opens {when}.',
  'event.checkBack': 'Please check back later.',
  'event.full': 'This event is full',
  'event.fullBody': 'The maximum number of registrations has been reached.',
  'event.closed': 'Registration is closed',
  'event.closedBody': 'This event is no longer accepting registrations.',
  'form.firstName': 'First name',
  'form.lastName': 'Last name',
  'form.email': 'Email',
  'form.emailHint': 'Only used by the organizer to contact you.',
  'form.phone': 'Phone',
  'form.phoneHint': 'With country code, e.g. +971 50 123 4567.',
  'form.readTerms': 'Read the attendance terms',
  'form.acceptTerms': 'I have read and accept the attendance terms.',
  'form.submit': 'Get my pass',
  'form.submitting': 'Getting your pass…',
  'form.noAccount': 'No account needed. Your pass appears straight away.',
  'error.nameRequired': '{label} is required.',
  'error.nameTooLong': '{label} must be at most {max} characters.',
  'error.nameChars': '{label} contains characters that are not allowed.',
  'error.nameLetter': '{label} must contain at least one letter.',
  'error.email': 'Enter a valid email address or leave it empty.',
  'error.phone': 'Enter the number with country code, e.g. +971 50 123 4567, or leave it empty.',
  'error.field': 'Please check this field.',
  'error.network': 'Network error. Check your connection and try again.',
  'error.rate_limited': 'Too many attempts from this network. Please wait a minute and try again.',
  'error.event_not_found': 'This event could not be found.',
  'error.registration_closed': 'Registration for this event is closed.',
  'error.registration_not_open': 'Registration for this event has not opened yet.',
  'error.event_full': 'This event has reached its maximum capacity.',
  'error.invalid_input': 'Please check the details you entered.',
  'error.terms_not_accepted': 'Please read and accept the attendance terms.',
  'error.terms_changed':
    'The organizer has just updated the attendance terms. Please read them again and accept.',
  'error.duplicate_request':
    'This registration was already submitted. Please reload the page to register again.',
  'error.pass_not_found': 'This pass could not be found. It may have been replaced by a newer pass.',
  'pass.title': 'Your pass',
  'pass.registered': "You're registered",
  'pass.keep': 'Keep this pass: save the image, add it to your calendar, or bookmark this page.',
  'pass.savedHere': 'Saved on this phone',
  'pass.kicker': 'Entry pass · one entry',
  'pass.date': 'Date',
  'pass.doors': 'Doors',
  'pass.venue': 'Venue',
  'pass.guest': 'Guest',
  'pass.qrAlt': 'Entry QR code for {name}',
  'pass.show': 'Show this QR code at the entrance.',
  'pass.brightness': 'Turn your screen brightness up at the door.',
  'pass.used': 'This pass was used for entry on {when}.',
  'pass.revoked': 'This pass has been revoked and is not valid for entry. Contact the organizer.',
  'pass.status.registered': 'Valid',
  'pass.status.used': 'Used',
  'pass.status.revoked': 'Revoked',
  'pass.calendar': 'Add to calendar',
  'pass.save': 'Save pass image',
  'pass.saveError': 'Could not save the image. Take a screenshot instead.',
  'pass.copy': 'Copy pass link',
  'pass.private': 'This link is your personal pass. Do not share it with others.',
  'pass.forget': 'Remove this pass from this device',
  'pass.forgetHint': 'Use this on a shared phone or tablet. Your pass stays valid.',
  'pass.missing': 'No pass in this link',
  'pass.missingBody': 'Open the full pass link you received after registering.',
  'pass.savedOnDevice': 'Passes saved on this device',
  'pass.notFound': 'Pass not found',
  'pass.loadError': 'Could not load pass',
  'pass.loadErrorBody': 'Could not load the pass.',
  'pass.calendarNote': 'Your pass: {url}',
  'home.intro':
    'Event registration and QR entry passes. To register, open the link or QR code shared by the event organizer.',
  'home.passes': 'Passes on this device',
  'home.staff': 'Staff sign in',
} as const

export type MessageKey = keyof typeof en

const ar: Record<MessageKey, string> = {
  'lang.switch': 'English',
  'lang.switchLabel': 'View this page in English',
  loading: 'جارٍ التحميل…',
  tryAgain: 'حاول مرة أخرى',
  optional: 'اختياري',
  'event.notFound': 'لم يتم العثور على الفعالية',
  'event.notFoundBody': 'تأكد من صحة الرابط. ربما لم تُنشر الفعالية بعد.',
  'event.error': 'حدث خطأ ما',
  'event.open': 'التسجيل مفتوح',
  'event.draft': 'معاينة: هذه الفعالية مسودة ولا يراها إلا فريق العمل. انشرها لفتح التسجيل.',
  'event.existing': 'لديك تذكرة لهذه الفعالية على هذا الجهاز',
  'event.viewPass': 'عرض تذكرة {name}',
  'event.registerAnother': 'يمكنك تسجيل شخص آخر أدناه.',
  'event.notOpen': 'لم يبدأ التسجيل بعد',
  'event.opensAt': 'يبدأ التسجيل في {when}.',
  'event.checkBack': 'يرجى المحاولة لاحقاً.',
  'event.full': 'اكتمل العدد',
  'event.fullBody': 'تم الوصول إلى الحد الأقصى للتسجيلات.',
  'event.closed': 'التسجيل مغلق',
  'event.closedBody': 'لم تعد هذه الفعالية تستقبل تسجيلات جديدة.',
  'form.firstName': 'الاسم الأول',
  'form.lastName': 'اسم العائلة',
  'form.email': 'البريد الإلكتروني',
  'form.emailHint': 'يستخدمه المنظِّم للتواصل معك فقط.',
  'form.phone': 'رقم الهاتف',
  'form.phoneHint': 'مع رمز الدولة، مثل ‎+971 50 123 4567.',
  'form.readTerms': 'اقرأ شروط الحضور',
  'form.acceptTerms': 'قرأت شروط الحضور وأوافق عليها.',
  'form.submit': 'احصل على تذكرتي',
  'form.submitting': 'جارٍ إصدار تذكرتك…',
  'form.noAccount': 'لا حاجة لإنشاء حساب. تظهر تذكرتك فوراً.',
  'error.nameRequired': '{label} مطلوب.',
  'error.nameTooLong': 'يجب ألا يتجاوز {label} {max} حرفاً.',
  'error.nameChars': 'يحتوي {label} على أحرف غير مسموح بها.',
  'error.nameLetter': 'يجب أن يحتوي {label} على حرف واحد على الأقل.',
  'error.email': 'أدخل بريداً إلكترونياً صحيحاً أو اتركه فارغاً.',
  'error.phone': 'أدخل الرقم مع رمز الدولة، مثل ‎+971 50 123 4567، أو اتركه فارغاً.',
  'error.field': 'يرجى مراجعة هذا الحقل.',
  'error.network': 'خطأ في الاتصال. تحقق من الشبكة وحاول مرة أخرى.',
  'error.rate_limited': 'محاولات كثيرة من هذه الشبكة. يرجى الانتظار دقيقة ثم المحاولة.',
  'error.event_not_found': 'تعذّر العثور على هذه الفعالية.',
  'error.registration_closed': 'التسجيل في هذه الفعالية مغلق.',
  'error.registration_not_open': 'لم يبدأ التسجيل في هذه الفعالية بعد.',
  'error.event_full': 'وصلت هذه الفعالية إلى الحد الأقصى من الحضور.',
  'error.invalid_input': 'يرجى مراجعة البيانات التي أدخلتها.',
  'error.terms_not_accepted': 'يرجى قراءة شروط الحضور والموافقة عليها.',
  'error.terms_changed': 'حدّث المنظِّم شروط الحضور للتو. يرجى قراءتها مجدداً والموافقة عليها.',
  'error.duplicate_request': 'تم إرسال هذا التسجيل مسبقاً. أعد تحميل الصفحة للتسجيل مرة أخرى.',
  'error.pass_not_found': 'تعذّر العثور على هذه التذكرة. ربما استُبدلت بتذكرة أحدث.',
  'pass.title': 'تذكرتك',
  'pass.registered': 'تم تسجيلك',
  'pass.keep': 'احتفظ بهذه التذكرة: احفظ الصورة أو أضفها إلى التقويم أو احفظ هذه الصفحة.',
  'pass.savedHere': 'محفوظة على هذا الهاتف',
  'pass.kicker': 'تذكرة دخول · دخول واحد',
  'pass.date': 'التاريخ',
  'pass.doors': 'الدخول',
  'pass.venue': 'المكان',
  'pass.guest': 'الضيف',
  'pass.qrAlt': 'رمز QR لدخول {name}',
  'pass.show': 'اعرض رمز QR هذا عند المدخل.',
  'pass.brightness': 'ارفع سطوع الشاشة عند المدخل.',
  'pass.used': 'استُخدمت هذه التذكرة للدخول في {when}.',
  'pass.revoked': 'أُلغيت هذه التذكرة ولم تعد صالحة للدخول. تواصل مع المنظِّم.',
  'pass.status.registered': 'صالحة',
  'pass.status.used': 'مستخدمة',
  'pass.status.revoked': 'ملغاة',
  'pass.calendar': 'أضف إلى التقويم',
  'pass.save': 'احفظ صورة التذكرة',
  'pass.saveError': 'تعذّر حفظ الصورة. التقط لقطة شاشة بدلاً من ذلك.',
  'pass.copy': 'انسخ رابط التذكرة',
  'pass.private': 'هذا الرابط هو تذكرتك الشخصية. لا تشاركه مع الآخرين.',
  'pass.forget': 'إزالة هذه التذكرة من هذا الجهاز',
  'pass.forgetHint': 'استخدم هذا على هاتف أو جهاز مشترك. تبقى تذكرتك صالحة.',
  'pass.missing': 'لا توجد تذكرة في هذا الرابط',
  'pass.missingBody': 'افتح رابط التذكرة الكامل الذي وصلك بعد التسجيل.',
  'pass.savedOnDevice': 'التذاكر المحفوظة على هذا الجهاز',
  'pass.notFound': 'لم يتم العثور على التذكرة',
  'pass.loadError': 'تعذّر تحميل التذكرة',
  'pass.loadErrorBody': 'تعذّر تحميل التذكرة.',
  'pass.calendarNote': 'تذكرتك: {url}',
  'home.intro':
    'التسجيل في الفعاليات وتذاكر الدخول برمز QR. للتسجيل، افتح الرابط أو رمز QR الذي شاركه منظِّم الفعالية.',
  'home.passes': 'التذاكر على هذا الجهاز',
  'home.staff': 'دخول فريق العمل',
}

const DICTIONARIES: Record<Lang, Record<MessageKey, string>> = { en, ar }

/** Locale for dates and numbers. Arabic keeps Western digits, as is common in the UAE. */
export const LOCALES: Record<Lang, string> = { en: 'en-GB', ar: 'ar-AE-u-nu-latn' }

export function translate(lang: Lang, key: MessageKey, vars?: Record<string, string | number>): string {
  const template = DICTIONARIES[lang][key] ?? en[key]
  return vars ? template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : template
}

export function initialLang(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved === 'en' || saved === 'ar') return saved
  } catch {
    /* storage unavailable */
  }
  return typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('ar') ? 'ar' : 'en'
}

export interface LangState {
  lang: Lang
  dir: 'ltr' | 'rtl'
  locale: string
  setLang: (lang: Lang) => void
  t: (key: MessageKey, vars?: Record<string, string | number>) => string
}

export const LangContext = createContext<LangState | null>(null)

/** Outside a LangProvider (staff pages, tests) everything is English. */
export function useT(): LangState {
  const ctx = useContext(LangContext)
  if (ctx) return ctx
  return {
    lang: 'en',
    dir: 'ltr',
    locale: LOCALES.en,
    setLang: () => undefined,
    t: (key, vars) => translate('en', key, vars),
  }
}

/** Guest-facing message for an API error code, falling back to the server's English text. */
export function errorMessage(
  t: LangState['t'],
  code: string | null | undefined,
  fallback: string | null | undefined,
): string {
  const key = `error.${code ?? ''}` as MessageKey
  if (code && key in en) return t(key)
  return fallback || t('error.network')
}
