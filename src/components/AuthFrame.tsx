import { BrandMark } from "@/components/BrandMark";

/** Split sign-in layout: night-city image with HTML branding on the left, form on the right.
 *  The image carries no text; on phones it becomes a short banner above the form. */
export function AuthFrame({ children }: { children: React.ReactNode }) {
  return (
    <main className="grid min-h-dvh bg-sidebar lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
      <section aria-label="Empire HR" className="relative flex min-h-56 flex-col justify-between overflow-hidden bg-navy p-6 text-white lg:min-h-dvh lg:p-12"
        style={{ backgroundImage: "linear-gradient(180deg, rgb(11 31 51 / 0.55) 0%, rgb(11 31 51 / 0.15) 45%, rgb(11 31 51 / 0.75) 100%), image-set(url(/images/empire-hr-login-bg.webp) type('image/webp'), url(/images/empire-hr-login-bg.jpg) type('image/jpeg'))",
                 backgroundSize: "cover", backgroundPosition: "80% center" }}>
        <div className="flex items-center gap-3"><BrandMark className="size-11" />
          <div><p className="text-[22px] leading-tight font-bold">Empire HR</p><p className="text-[13.5px] text-white/80">Empire Networks Pvt Ltd</p></div></div>
        <div className="mt-10 hidden max-w-lg lg:block">
          <p className="text-[34px] leading-[1.15] font-semibold tracking-[-0.01em]">People. Attendance. Payroll.<br /><span className="text-accent-bright">All in one place.</span></p>
          <p className="mt-3 text-[16px] text-white/85">Empowering your workforce, one shift at a time.</p>
        </div>
      </section>
      <section className="flex min-w-0 items-center justify-center bg-canvas px-4 py-10">
        <div className="w-full min-w-0 max-w-[400px]">{children}</div>
      </section>
    </main>);
}
