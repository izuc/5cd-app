import { Link } from 'react-router-dom';
import { Icon } from '../components/Icon';

export function LandingPage() {
  return (
    <main className="hero-gradient min-h-screen">
      <section className="max-w-[1440px] mx-auto px-6 pt-20 pb-24 md:pt-32">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-16 items-center">
          <div className="lg:col-span-7 flex flex-col items-start gap-8">
            <h1 className="font-headline text-5xl sm:text-6xl md:text-8xl font-black tracking-tighter leading-[0.9] text-on-surface">
              Designs<br />from <span className="text-primary italic">5 cents</span>
            </h1>
            <p className="text-lg sm:text-xl text-on-surface-variant max-w-lg leading-relaxed">
              Generate a polished design in one shot, then chat to refine it. One unified model handles both
              text-to-image and image edits — no layer juggling needed.
            </p>
            <div className="flex flex-wrap gap-4 pt-4">
              <Link to="/register" className="bg-primary-container text-on-primary-container px-8 py-4 rounded-xl font-headline font-bold text-lg shadow-xl shadow-primary-container/20 hover:scale-105 active:scale-95 transition-all">
                Start Designing
              </Link>
              <a href="#how-it-works" className="bg-surface-container-lowest text-on-surface px-8 py-4 rounded-xl font-headline font-bold text-lg border border-outline-variant/15 hover:bg-surface-container-low transition-colors">
                How It Works
              </a>
            </div>
          </div>
          <div className="lg:col-span-5 relative hidden sm:block">
            <div className="relative w-full aspect-square bg-surface-container-low rounded-3xl overflow-hidden shadow-2xl">
              <div className="absolute inset-0 p-8 flex flex-col items-center justify-center gap-6">
                <div className="w-full max-w-xs aspect-square rounded-2xl bg-white shadow-xl border border-outline-variant/10 flex items-center justify-center">
                  <div className="text-center space-y-3">
                    <Icon name="auto_awesome" className="text-6xl text-primary" />
                    <p className="font-headline font-bold text-on-surface-variant text-sm">AI-Generated Design</p>
                  </div>
                </div>
                <div className="flex gap-3">
                  {['edit', 'palette', 'chat', 'download'].map((icon) => (
                    <div key={icon} className="w-12 h-12 rounded-xl bg-surface-container-lowest shadow-lg border border-outline-variant/10 flex items-center justify-center">
                      <Icon name={icon} className="text-on-surface-variant" />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="bg-surface-container-low py-16">
        <div className="max-w-[1440px] mx-auto px-6">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-6 md:gap-12">
            {[
              { icon: 'auto_awesome', label: 'One-shot Generate', desc: 'Polished output in one pass' },
              { icon: 'chat', label: 'Chat to Edit', desc: 'Tweak via plain English' },
              { icon: 'image', label: 'Bring References', desc: 'Edit your existing designs' },
              { icon: 'savings', label: 'From 5 Cents', desc: 'Affordable for everyone' },
            ].map((feature) => (
              <div key={feature.label} className="text-center space-y-3">
                <div className="w-14 h-14 mx-auto rounded-2xl bg-primary-container/20 flex items-center justify-center">
                  <Icon name={feature.icon} className="text-2xl text-primary" />
                </div>
                <h3 className="font-headline font-extrabold text-lg tracking-tight">{feature.label}</h3>
                <p className="text-sm text-on-surface-variant">{feature.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="how-it-works" className="max-w-[1440px] mx-auto px-6 py-24 md:py-32">
        <div className="mb-16 max-w-xl">
          <p className="font-label text-sm font-bold text-secondary uppercase tracking-[0.3em] mb-4">How It Works</p>
          <h2 className="font-headline text-4xl sm:text-5xl md:text-6xl font-black tracking-tighter text-on-surface">
            Three steps to a finished design.
          </h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {[
            { num: '01', title: 'Describe', desc: 'Type a prompt — or attach a reference image to edit.', hoverBg: 'group-hover:bg-primary-container', hoverText: 'group-hover:text-on-primary-container' },
            { num: '02', title: 'Generate', desc: 'Get a high-fidelity design in one pass.', hoverBg: 'group-hover:bg-secondary-container', hoverText: 'group-hover:text-on-secondary-container' },
            { num: '03', title: 'Chat & Export', desc: 'Refine via the chat sidebar, then export PNG / JPG / PDF.', hoverBg: 'group-hover:bg-tertiary-container', hoverText: 'group-hover:text-on-tertiary-container' },
          ].map((step) => (
            <div key={step.num} className={`bg-surface-container-lowest p-8 rounded-3xl border border-outline-variant/5 ${step.hoverBg} group transition-colors cursor-default`}>
              <p className={`font-headline font-black text-6xl text-surface-variant ${step.hoverText}/20 mb-8`}>{step.num}</p>
              <h3 className={`font-headline text-2xl font-extrabold mb-4 ${step.hoverText}`}>{step.title}</h3>
              <p className={`text-on-surface-variant ${step.hoverText}/80 leading-relaxed`}>{step.desc}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="max-w-[1440px] mx-auto px-6 pb-24">
        <div className="bg-on-surface rounded-[2rem] sm:rounded-[40px] p-8 sm:p-12 md:p-24 text-center relative overflow-hidden">
          <div className="absolute top-0 right-0 w-96 h-96 bg-primary-container/20 blur-[100px] -mr-48 -mt-48" />
          <div className="relative z-10 max-w-2xl mx-auto">
            <h2 className="font-headline text-4xl sm:text-5xl md:text-7xl font-black tracking-tighter text-surface mb-8">
              Ready to design?
            </h2>
            <p className="text-surface/60 text-lg sm:text-xl mb-12">
              Sign up free, get five credits, and start generating.
            </p>
            <Link to="/register" className="inline-block bg-primary-container text-on-primary-container px-12 py-5 rounded-2xl font-headline font-black text-xl sm:text-2xl hover:scale-105 active:scale-95 transition-all">
              Start Designing Free
            </Link>
          </div>
        </div>
      </section>

      <footer className="bg-surface py-16 border-t border-outline-variant/10">
        <div className="max-w-[1440px] mx-auto px-6">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-12">
            <div>
              <span className="text-3xl font-black text-on-surface tracking-tighter font-headline mb-6 block">5cd</span>
              <p className="text-on-surface-variant max-w-xs leading-relaxed">
                AI-powered design studio. One-shot generation + chat-based editing.
              </p>
            </div>
            <div>
              <h4 className="font-label text-xs font-bold uppercase tracking-widest text-on-surface mb-6">Product</h4>
              <ul className="space-y-4">
                <li><a className="text-on-surface-variant hover:text-primary transition-colors" href="#how-it-works">How It Works</a></li>
                <li><Link className="text-on-surface-variant hover:text-primary transition-colors" to="/register">Get Started</Link></li>
              </ul>
            </div>
            <div>
              <p className="font-label text-[10px] uppercase text-on-surface-variant tracking-widest">&copy; 2026 5cd. All rights reserved.</p>
            </div>
          </div>
        </div>
      </footer>
    </main>
  );
}
