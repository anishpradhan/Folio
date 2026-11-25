import { lazy, Suspense, useEffect } from 'react';
import { useRoute } from './lib/router';
import { usePrefs } from './state/prefs';
import { TooltipLayer, FeedbackLayer, Spinner, useFeedback } from './components/ui';
import { AppShell } from './features/shell/AppShell';
import { LibraryPage } from './features/library/LibraryPage';
import { purgeExpiredDeletes } from './data/repo';

// The reader pulls in pdf.js rendering code; keep the library's first paint light.
const ReaderPage = lazy(() => import('./features/reader/ReaderPage'));
const InsightsPage = lazy(() => import('./features/insights/InsightsPage'));
const VocabularyPage = lazy(() => import('./features/vocabulary/VocabularyPage'));
const JournalPage = lazy(() => import('./features/journal/JournalPage'));
const StatsPage = lazy(() => import('./features/stats/StatsPage'));

function Loading() {
  return (
    <div className="grid h-full min-h-[50vh] place-items-center text-ink-3">
      <Spinner size={20} />
    </div>
  );
}

export default function App() {
  const route = useRoute();
  const appTheme = usePrefs((s) => s.appTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = appTheme;
  }, [appTheme]);

  // Quiet confirmations belong to the screen they were made on; offers with an action
  // (Undo, Open) are kept so they stay usable after navigating.
  const routeKey = route.name === 'read' ? `read:${route.id}` : route.name;
  useEffect(() => {
    const fb = useFeedback.getState();
    fb.items.filter((i) => !i.action || /Read now/.test(i.action.label)).forEach((i) => fb.dismiss(i.id));
  }, [routeKey]);

  useEffect(() => {
    void purgeExpiredDeletes()
      .then(() => import('./core/pdf/indexText'))
      .then((m) => m.resumePendingIndexing());
    // Ask the browser not to evict our library under storage pressure.
    void navigator.storage?.persist?.().catch(() => {});
  }, []);

  return (
    <>
      {route.name === 'read' ? (
        <Suspense fallback={<Loading />}>
          <ReaderPage key={route.id} docId={route.id} initialPage={route.page} focusHighlight={route.highlight} />
        </Suspense>
      ) : (
        <AppShell route={route}>
          <Suspense fallback={<Loading />}>
            {route.name === 'library' && <LibraryPage collection={route.collection} />}
            {route.name === 'insights' && <InsightsPage />}
            {route.name === 'vocabulary' && <VocabularyPage />}
            {route.name === 'journal' && <JournalPage />}
            {route.name === 'stats' && <StatsPage />}
          </Suspense>
        </AppShell>
      )}
      <TooltipLayer />
      <FeedbackLayer />
    </>
  );
}
