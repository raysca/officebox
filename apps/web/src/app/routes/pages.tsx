import type { ComponentType, SVGProps } from "react";
import { EmptyState } from "../../lib/ui/EmptyState";
import { CalendarIcon, ChatIcon, DocumentIcon, HomeIcon } from "../../lib/ui/icons";
import { Link } from "../../lib/ui/Link";
import { messages } from "../messages";
import { Page } from "../Page";

type AreaKey = keyof typeof messages.areas;

/** An area that exists in the navigation but has no feature yet. */
function ComingSoon({ area, icon: Icon }: { area: AreaKey; icon: ComponentType<SVGProps<SVGSVGElement>> }) {
  const { label, description } = messages.areas[area];
  return (
    <Page title={label}>
      <EmptyState icon={<Icon width={32} height={32} />} title={messages.comingSoon} description={description} />
    </Page>
  );
}

export const HomePage = () => <ComingSoon area="home" icon={HomeIcon} />;
export const ChatPage = () => <ComingSoon area="chat" icon={ChatIcon} />;
export const CalendarPage = () => <ComingSoon area="calendar" icon={CalendarIcon} />;
export const DocumentsPage = () => <ComingSoon area="documents" icon={DocumentIcon} />;

export function NotFoundPage() {
  return (
    <Page title={messages.notFound.title} description={messages.notFound.description}>
      <p>
        <Link to="/">{messages.notFound.home}</Link>
      </p>
    </Page>
  );
}
