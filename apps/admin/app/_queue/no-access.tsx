import { Notice } from "@portal/ui";

/** The page for a staff login whose roles do not cover this queue. It says so and shows nothing from the queue. */
export function NoAccess({ title, role }: { title: string; role: string }) {
  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <h1 className="mb-1 text-[32px] leading-tight md:text-[34px]">{title}</h1>
      <Notice kind="info" title="This page is not for your roles">
        {`It is for staff with the ${role} role. Ask an administrator if you need it. The links on the left are the pages your roles can open.`}
      </Notice>
    </div>
  );
}
