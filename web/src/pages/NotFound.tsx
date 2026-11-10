import { Link } from 'react-router-dom';
import { useI18n } from '../i18n/i18n';

export default function NotFound() {
  const { t } = useI18n();
  return (
    <div data-screen="not-found" className="flex flex-col items-start gap-3">
      <h1 className="m-0 text-headline">{t('product.not_found_h')}</h1>
      <Link to="/" className="font-semibold">
        {t('product.back_home')}
      </Link>
    </div>
  );
}
