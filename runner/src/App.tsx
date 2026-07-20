import { useIsMobile } from './hooks/useIsMobile';
import { useTestStream } from './hooks/useTestStream';
import { DesktopView } from './views/DesktopView';
import { MobileView } from './views/MobileView';

export default function App() {
  const isMobile = useIsMobile();
  const {
    summary, tests, logs, auth, paused,
    start, stop, pause, resume, signIn, cancelSignIn,
  } = useTestStream();

  const shared = {
    summary,
    tests,
    auth,
    paused,
    onStart: start,
    onStop: stop,
    onPause: pause,
    onResume: resume,
    onSignIn: signIn,
    onCancelSignIn: cancelSignIn,
  };

  return isMobile ? <MobileView {...shared} /> : <DesktopView {...shared} logs={logs} />;
}
