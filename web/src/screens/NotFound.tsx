import { Link } from 'react-router';
import { Compass } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';

export default function NotFound() {
  return (
    <div className="flex min-h-[60svh] items-center justify-center">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Compass aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>Page not found</EmptyTitle>
          <EmptyDescription>
            This page doesn&rsquo;t exist — maybe the link is old or mistyped.
          </EmptyDescription>
        </EmptyHeader>
        <Button className="rounded-full px-6" render={<Link to="/" />}>
          Back to groups
        </Button>
      </Empty>
    </div>
  );
}
