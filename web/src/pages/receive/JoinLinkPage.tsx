import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Banner, Screen } from '../../components/ui';
import { useI18n } from '../../i18n/i18n';
import { useIdentity } from '../../lib/identity/identity';
import { useSharing } from '../../features/sharing/SharingContext';
import { joinErrorMessage } from '../../features/sharing/errors';
import { serverOffset } from '../../features/sharing/api';
import { IdentityNotice } from '../../features/identity/IdentityNotice';
import { markWelcomeSeen } from '../../lib/prefs';

/** RX-3 / Web join page `/j/:token`: resolves the link once the device identity is ready, then shows RX-4. */
export default function JoinLinkPage() {
  const { token = '' } = useParams();
  const { t } = useI18n();
  const navigate = useNavigate();
  const { api } = useSharing();
  const { status } = useIdentity();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  useEffect(() => {
    if (status.kind !== 'ready' || started.current) return;
    started.current = true;
    markWelcomeSeen(); // a receiver arriving by link never sees Welcome (PRD §5.1)
    api
      .resolveLink(token)
      .then((preview) =>
        navigate('/join/preview', {
          replace: true,
          state: { preview, offset: serverOffset(preview.server_time), source: { token } },
        }),
      )
      .catch((e: unknown) => setError(joinErrorMessage(t, e)));
  }, [status.kind, api, token, navigate, t]);
  return (
    <Screen id="receive-preview">
      <div className="mx-auto flex w-full max-w-[560px] flex-col gap-4">
        <IdentityNotice />
        {error ? (
          <>
            <Banner tone="warning" role="alert" title={t('product.link_expired_h')}>
              {error}
            </Banner>
            <Link to="/receive" className="font-semibold">
              {t('product.another_code')}
            </Link>
          </>
        ) : (
          <p className="text-fg-2" role="status">
            {t('product.opening_link')}
          </p>
        )}
      </div>
    </Screen>
  );
}
