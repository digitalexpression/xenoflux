import { Link, type RouteObject } from 'react-router';
import { Page, PageTitle } from './components/layout';
import { BrowseSessions } from './pages/BrowseSessions';
import { NativeSessions } from './pages/NativeSessions';
import { ChooseSessions } from './pages/ChooseSessions';
import { CopyPreview } from './pages/CopyPreview';
import { Export } from './pages/Export';
import { Discovery } from './pages/Discovery';
import { Landing } from './pages/Landing';
import { OpenSaved } from './pages/OpenSaved';
import { Profiles } from './pages/Profiles';
import { Report } from './pages/Report';
import { Reviews } from './pages/Reviews';
import { RunNew, RunProgress, RunReview } from './pages/Runs';
import { ProfileSetup } from './pages/ProfileSetup';
import { SetupComparison } from './pages/SetupComparison';
import { SkillDetail } from './pages/SkillDetail';

function NotFound() {
  return (
    <Page current={null} title="Not found">
      <PageTitle title="This page doesn’t exist" subtitle="The link may be from an older version of Xenoflux." />
      <div><Link className="btn" to="/">Go to Compare</Link></div>
    </Page>
  );
}

// Expose the local product screens and keep Recent links on these routes.
export const routes: RouteObject[] = [
  { path: '/', element: <Landing /> },
  { path: '/setup', element: <Discovery /> },
  { path: '/profiles', element: <Profiles /> },
  { path: '/profiles/new', element: <CopyPreview mode="create" /> },
  { path: '/profiles/:name/setup', element: <ProfileSetup /> },
  { path: '/profiles/:name/copy', element: <CopyPreview mode="copy" /> },
  { path: '/compare/setups', element: <SetupComparison /> },
  { path: '/compare/setups/skills/:skill', element: <SkillDetail /> },
  { path: '/compare/sessions/native', element: <NativeSessions /> },
  { path: '/compare/sessions', element: <ChooseSessions /> },
  { path: '/sessions', element: <BrowseSessions /> },
  { path: '/reports/open', element: <OpenSaved /> },
  { path: '/reports/:ref', element: <Report /> },
  { path: '/reports/:ref/export', element: <Export /> },
  { path: '/reports/:ref/reviews', element: <Reviews /> },
  { path: '/runs/new', element: <RunNew /> },
  { path: '/runs/new/review', element: <RunReview /> },
  { path: '/runs/:id', element: <RunProgress /> },
  { path: '*', element: <NotFound /> },
];
