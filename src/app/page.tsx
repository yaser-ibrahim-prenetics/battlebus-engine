import Link from "next/link";

export default function Home() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-indigo-950 to-slate-950">
      {/* Animated background grid */}
      <div className="absolute inset-0 bg-[linear-gradient(rgba(99,102,241,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(99,102,241,0.03)_1px,transparent_1px)] bg-[size:64px_64px]" />
      
      <div className="relative z-10 flex flex-col items-center justify-center min-h-screen p-8">
        {/* Logo/Icon */}
        <div className="mb-8 relative">
          <div className="w-24 h-24 rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-2xl shadow-indigo-500/25">
            <svg
              className="w-14 h-14 text-white"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M13 10V3L4 14h7v7l9-11h-7z"
              />
            </svg>
          </div>
          <div className="absolute -inset-1 bg-gradient-to-r from-indigo-500 to-purple-600 rounded-2xl blur-xl opacity-30 -z-10" />
        </div>

        {/* Title */}
        <h1 className="text-5xl md:text-7xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-white via-indigo-200 to-purple-200 mb-4 tracking-tight">
          Battle Bus
        </h1>
        
        <p className="text-xl text-indigo-200/70 mb-2 font-light">
          IM8 Order Orchestration Engine
        </p>
        
        <p className="text-sm text-indigo-300/50 mb-12 max-w-md text-center">
          Durable execution for Shopify → D365 → Warehouse integrations
        </p>

        {/* Status Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-12 w-full max-w-3xl">
          <StatusCard
            title="Inngest"
            status="Connected"
            icon={
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
            }
          />
          <StatusCard
            title="Webhooks"
            status="6 Endpoints"
            icon={
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
              </svg>
            }
          />
          <StatusCard
            title="Functions"
            status="6 Active"
            icon={
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4" />
              </svg>
            }
          />
        </div>

        {/* Function List */}
        <div className="w-full max-w-3xl bg-slate-900/50 backdrop-blur-xl rounded-2xl border border-indigo-500/20 p-6 mb-8">
          <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            Active Functions
          </h2>
          <div className="space-y-2">
            <FunctionRow name="process-shopify-order" trigger="shopify/order.created" />
            <FunctionRow name="process-shopify-refund" trigger="shopify/refund.created" />
            <FunctionRow name="process-gps-fulfilment" trigger="gps/fulfilment.received" />
            <FunctionRow name="process-stord-fulfilment" trigger="stord/fulfilment.received" />
            <FunctionRow name="process-loop-return" trigger="loop/return.created" />
            <FunctionRow name="process-prive-notification" trigger="prive/notification.received" />
          </div>
        </div>

        {/* Links */}
        <div className="flex gap-4">
          <Link
            href="/api/inngest"
            className="px-6 py-3 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl font-medium transition-all hover:shadow-lg hover:shadow-indigo-500/25"
          >
            Inngest Dashboard →
          </Link>
          <a
            href="https://app.inngest.com"
            target="_blank"
            rel="noopener noreferrer"
            className="px-6 py-3 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl font-medium transition-all border border-slate-700"
          >
            Inngest Cloud
          </a>
        </div>

        {/* Footer */}
        <p className="mt-16 text-xs text-slate-600">
          Operation Battle-Bus • Replacing spock-store polling with durable execution
        </p>
      </div>
    </div>
  );
}

function StatusCard({
  title,
  status,
  icon,
}: {
  title: string;
  status: string;
  icon: React.ReactNode;
}) {
  return (
    <div className="bg-slate-900/50 backdrop-blur-xl rounded-xl border border-indigo-500/20 p-4 flex items-center gap-4">
      <div className="w-10 h-10 rounded-lg bg-indigo-500/20 flex items-center justify-center text-indigo-400">
        {icon}
      </div>
      <div>
        <p className="text-sm text-slate-400">{title}</p>
        <p className="text-white font-medium">{status}</p>
      </div>
    </div>
  );
}

function FunctionRow({ name, trigger }: { name: string; trigger: string }) {
  return (
    <div className="flex items-center justify-between py-2 px-3 rounded-lg hover:bg-slate-800/50 transition-colors">
      <div className="flex items-center gap-3">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
        <code className="text-sm text-indigo-300 font-mono">{name}</code>
      </div>
      <code className="text-xs text-slate-500 font-mono">{trigger}</code>
    </div>
  );
}
