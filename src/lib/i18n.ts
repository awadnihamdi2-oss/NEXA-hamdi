import type { CoreState, EnvironmentId, UiLang } from '../types/ui';

interface TranslationBundle {
  brandTitle: string;
  brandSubtitle: string;
  clusters: Record<'PORTAL' | 'INTELLIGENCE' | 'DOMAINS' | 'GOVERNANCE', string>;
  envs: Record<EnvironmentId, { label: string; shortLabel: string; subtitle: string }>;
  coreStates: Record<CoreState, { label: string; shortLabel: string; detail: string }>;
  common: {
    sync: string;
    role: string;
    gates: string;
    freeOnlyLock: string;
    paperOnlyLock: string;
    lowPowerMode: string;
    webglMode: string;
    launchMission: string;
    interpretObjective: string;
    openWorkspace: string;
    inspectCore: string;
    restoreHud: string;
    send: string;
    cancel: string;
    refresh: string;
    noData: string;
  };
  genesis: {
    kicker: string;
    headline: string;
    subline: string;
    commandPlaceholder: string;
    quickPromptsTitle: string;
    quickPrompts: Array<{ label: string; domain: string; prompt: string }>;
  };
}

export const I18N: Record<UiLang, TranslationBundle> = {
  en: {
    brandTitle: 'NEXA',
    brandSubtitle: 'Eternal Intelligence Observatory',
    clusters: {
      PORTAL: 'Core Observatory',
      INTELLIGENCE: 'Cognitive Matrix',
      DOMAINS: 'Intelligence Domains',
      GOVERNANCE: 'Verification & Control',
    },
    envs: {
      genesis: { label: 'Genesis Observatory', shortLabel: 'Genesis', subtitle: 'Central spatial singularity and natural-language mission synthesis' },
      command: { label: 'Command Kernel', shortLabel: 'Command', subtitle: 'Mission wave timeline, multilingual dialogue, and acoustic voice' },
      network: { label: 'Intelligence Network', shortLabel: 'Network', subtitle: 'Live 15-agent structural topology, contracts, and SQLite provenance' },
      models: { label: 'Model Laboratory', shortLabel: 'Models', subtitle: '8-provider adapters, capability comparison, and zero-cost verification' },
      research: { label: 'Research Observatory', shortLabel: 'Research', subtitle: 'Live arXiv discovery, evidence provenance, and contradiction audit' },
      memory: { label: 'Memory Architecture', shortLabel: 'Memory', subtitle: 'Seven-scope persistent knowledge store with SHA-256 deduplication' },
      quant: { label: 'Quant Laboratory', shortLabel: 'Quant', subtitle: 'OHLCV validation, strategy backtesting, Walk-Forward OOS & Monte Carlo' },
      commerce: { label: 'Commerce Intelligence', shortLabel: 'Commerce', subtitle: 'Opportunity scoring, CRM pipeline, non-fiscal drafts & site builder' },
      engineering: { label: 'Engineering Forge', shortLabel: 'Forge', subtitle: 'Sandboxed workspace scaffolding, isolated test runner & snapshots' },
      analytics: { label: 'System Analytics', shortLabel: 'Analytics', subtitle: 'Execution latency telemetry, epistemic balance & SHA-256 artifact ledger' },
      security: { label: 'Security Vault', shortLabel: 'Security', subtitle: 'PBKDF2 authentication, RBAC access control, approvals & audit trail' },
      control: { label: 'System Control', shortLabel: 'Control', subtitle: 'Environment readiness, safety ceiling locks, persistence & VACUUM backups' },
    },
    coreStates: {
      dormant: { label: 'Dormant Equilibrium', shortLabel: 'Dormant', detail: 'Low-energy orbital standby' },
      aware: { label: 'Aware Reception', shortLabel: 'Aware', detail: 'Objective parser primed' },
      listening: { label: 'Acoustic Intake', shortLabel: 'Listening', detail: 'Microphone stream active' },
      reasoning: { label: 'Deep Reasoning', shortLabel: 'Reasoning', detail: 'Formal multi-step synthesis' },
      collaborating: { label: 'Council Synchronized', shortLabel: 'Collaborating', detail: '15 specialist nodes coordinated' },
      executing: { label: 'Wave Execution', shortLabel: 'Executing', detail: 'Kernel pipeline computing waves' },
      speaking: { label: 'Vocal Output', shortLabel: 'Speaking', detail: 'Speech synthesis modulation' },
      completed: { label: 'Verified Completion', shortLabel: 'Completed', detail: 'Outputs sealed and persisted' },
      failed: { label: 'Diagnostic Fault', shortLabel: 'Fault', detail: 'Execution halted on safety or gate check' },
    },
    common: {
      sync: 'Synchronize',
      role: 'Role',
      gates: 'Pending Gates',
      freeOnlyLock: 'Paid Auto-Fallback Locked',
      paperOnlyLock: 'Paper Simulation Only',
      lowPowerMode: '2D Observatory',
      webglMode: '3D Spatial',
      launchMission: 'Execute Pipeline',
      interpretObjective: 'Map Objective',
      openWorkspace: 'Enter Space',
      inspectCore: 'Inspect Monument',
      restoreHud: 'Restore Controls',
      send: 'Transmit',
      cancel: 'Cancel',
      refresh: 'Refresh',
      noData: 'No records persisted yet.',
    },
    genesis: {
      kicker: 'The Eternal Intelligence Architecture',
      headline: 'Coordinate specialized research, quantitative validation, and software engineering as one coherent system.',
      subline: 'Express any complex objective in English, Arabic, or French. NEXA analyzes ambiguity, schedules dependency waves, selects verified free models, and persists signed outputs.',
      commandPlaceholder: 'State an objective: evaluate XAUUSD mean-reversion risk, design a fault-tolerant TS service, compare free reasoning models, or synthesize arXiv research...',
      quickPromptsTitle: 'Calibrated Objectives',
      quickPrompts: [
        { label: 'Quant Volatility Audit', domain: 'quant', prompt: 'Evaluate XAUUSD SMA crossover vs RSI mean-reversion across high-volatility regimes with 70/30 walk-forward validation.' },
        { label: 'Service Architecture', domain: 'software', prompt: 'Design a resilient TypeScript worker queue with deterministic retry backoff, SQLite persistence, and automated regression tests.' },
        { label: 'Academic Synthesis', domain: 'research', prompt: 'Investigate algorithmic market microstructure papers on arXiv and extract verifiable hypotheses separated from assumptions.' },
        { label: 'Commercial Feasibility', domain: 'commerce', prompt: 'Assess local B2B clinical appointment automation opportunity economics without inventing unverified revenue projections.' },
      ],
    },
  },
  ar: {
    brandTitle: 'نيكسا',
    brandSubtitle: 'مرصد الذكاء الأبدي الكمي',
    clusters: {
      PORTAL: 'المرصد الرئيسي',
      INTELLIGENCE: 'شبكة الذكاء',
      DOMAINS: 'المختبرات التخصصية',
      GOVERNANCE: 'الحوكمة والتحكم',
    },
    envs: {
      genesis: { label: 'بوابة التكوين', shortLabel: 'التكوين', subtitle: 'النواة المكانية التفاعلية وترجمة الأهداف إلى مسارات تنفيذية' },
      command: { label: 'مركز القيادة', shortLabel: 'القيادة', subtitle: 'إدارة المهام المركزية، المحادثة متعددة اللغات، والواجهة الصوتية' },
      network: { label: 'شبكة الوكلاء', shortLabel: 'الشبكة', subtitle: 'مخطط حي لـ 15 وكيلاً متخصصاً وعقود الإدخال والإخراج والتبعيات' },
      models: { label: 'مختبر النماذج', shortLabel: 'النماذج', subtitle: 'مزودو الذكاء الاصطناعي ومصفوفة المقارنة والاختبار الآمن دون تكلفة' },
      research: { label: 'مرصد الأبحاث', shortLabel: 'الأبحاث', subtitle: 'استرجاع أوراق arXiv وتحليل التناقضات وتصنيف الحقائق والفرضيات' },
      memory: { label: 'هندسة الذاكرة', shortLabel: 'الذاكرة', subtitle: 'ذاكرة دائمة من 7 نطاقات مع إزالة التكرار بتوقيع SHA-256' },
      quant: { label: 'المختبر الكمي', shortLabel: 'الكمي', subtitle: 'فحص البيانات والاختبار الخلفي ومحاكاة مونت كارلو ومكتب التداول الورقي' },
      commerce: { label: 'الذكاء التجاري', shortLabel: 'التجارة', subtitle: 'تقييم الفرص التجارية وإدارة العملاء والفواتير المسودة المحكومة بالموافقة' },
      engineering: { label: 'مصنع الهندسة', shortLabel: 'الهندسة', subtitle: 'بيئة برمجة معزولة وتشغيل الاختبارات ونقاط الاسترجاع الفورية' },
      analytics: { label: 'التحليلات والأدلة', shortLabel: 'التحليلات', subtitle: 'مقاييس الأداء وزمن الاستجابة وسجل المخرجات الموثقة بـ SHA-256' },
      security: { label: 'خزنة الأمان', shortLabel: 'الأمان', subtitle: 'التحقق بالبصمة والصلاحيات RBAC وبوابات الموافقة البشرية وسجل التدقيق' },
      control: { label: 'التحكم بالنظام', shortLabel: 'التحكم', subtitle: 'جاهزية البيئة وأقفال الأمان وإعدادات القاعدة والنسخ الاحتياطي' },
    },
    coreStates: {
      dormant: { label: 'سكون متزن', shortLabel: 'سكون', detail: 'وضع الاستعداد المداري' },
      aware: { label: 'استقبال واعٍ', shortLabel: 'استقبال', detail: 'تهيئة محلل الأهداف' },
      listening: { label: 'استماع صوتي', shortLabel: 'استماع', detail: 'تدفق الميكروفون نشط' },
      reasoning: { label: 'استدلال عميق', shortLabel: 'استدلال', detail: 'تحليل منطقي متعدد الخطوات' },
      collaborating: { label: 'تزامن المجلس', shortLabel: 'تعاون', detail: 'تفاعل 15 وكيلاً متخصصاً' },
      executing: { label: 'تنفيذ الموجات', shortLabel: 'تنفيذ', detail: 'النواة تعالج المراحل المتوازية' },
      speaking: { label: 'نطق صوتي', shortLabel: 'نطق', detail: 'تشكيل الإخراج الصوتي' },
      completed: { label: 'اكتمال موثق', shortLabel: 'مكتمل', detail: 'حفظ النتائج وتوثيقها' },
      failed: { label: 'تنبيه تشخيصي', shortLabel: 'تعطل', detail: 'توقف التنفيذ عند بوابة أمان' },
    },
    common: {
      sync: 'مزامنة',
      role: 'الصلاحية',
      gates: 'بوابات معلقة',
      freeOnlyLock: 'البديل المدفوع مقفل',
      paperOnlyLock: 'تداول ورقي فقط',
      lowPowerMode: 'مرصد ثنائي الأبعاد',
      webglMode: 'فضاء ثلاثي الأبعاد',
      launchMission: 'تنفيذ المهمة',
      interpretObjective: 'تحليل المسار',
      openWorkspace: 'دخول البيئة',
      inspectCore: 'فحص النواة',
      restoreHud: 'إظهار التحكم',
      send: 'إرسال',
      cancel: 'إلغاء',
      refresh: 'تحديث',
      noData: 'لا توجد سجلات محفوظة بعد.',
    },
    genesis: {
      kicker: 'منظومة الذكاء الأبدي المتكاملة',
      headline: 'وجّه أبحاثاً متخصصة وتحققاً كمياً وهندسة برمجية كمنظومة معرفية واحدة.',
      subline: 'أدخل أي هدف مركب بالعربية أو الإنجليزية أو الفرنسية. ترصد NEXA الغموض وتجدول موجات الوكلاء وتختار النماذج المجانية الموثقة وتوثق المخرجات.',
      commandPlaceholder: 'اكتب هدفك هنا: حلل استراتيجية XAUUSD، صمم خدمة TypeScript موثوقة، قارن النماذج المجانية، أو ابحث في أوراق arXiv...',
      quickPromptsTitle: 'أهداف معايرة جاهزة',
      quickPrompts: [
        { label: 'تدقيق التذبذب الكمي', domain: 'quant', prompt: 'قيّم استراتيجية تقاطع المتوسطات مقابل RSI على XAUUSD مع اختبار Walk-Forward 70/30.' },
        { label: 'معمارية خدمة برمجية', domain: 'software', prompt: 'صمم نظام مهام TypeScript مرن مع إعادة المحاولة المنضبطة وحفظ SQLite واختبارات تلقائية.' },
        { label: 'استكشاف أوراق علمية', domain: 'research', prompt: 'ابحث في أوراق arXiv حول البنية الدقيقة للأسواق واستخلص الفرضيات المفصولة عن الحقائق المؤكدة.' },
        { label: 'جدوى تجارية محلية', domain: 'commerce', prompt: 'حلل جدوى أتمتة مواعيد العيادات المحلية دون اختلاق أرقام إيرادات غير موثقة.' },
      ],
    },
  },
  fr: {
    brandTitle: 'NEXA',
    brandSubtitle: 'Observatoire d’Intelligence Éternelle',
    clusters: {
      PORTAL: 'Observatoire Central',
      INTELLIGENCE: 'Matrice Cognitive',
      DOMAINS: 'Laboratoires Métier',
      GOVERNANCE: 'Vérification & Contrôle',
    },
    envs: {
      genesis: { label: 'Portail Genesis', shortLabel: 'Genesis', subtitle: 'Singularité spatiale centrale et synthèse d’objectifs en langage naturel' },
      command: { label: 'Centre de Commande', shortLabel: 'Commande', subtitle: 'Orchestration noyau, dialogue multilingue et interface vocale' },
      network: { label: 'Réseau Cognitif', shortLabel: 'Réseau', subtitle: 'Topologie des 15 agents spécialisés, contrats I/O et traçabilité' },
      models: { label: 'Laboratoire Modèles', shortLabel: 'Modèles', subtitle: '8 adaptateurs fournisseurs, matrice comparative et tests sans frais' },
      research: { label: 'Observatoire Recherche', shortLabel: 'Recherche', subtitle: 'Découverte arXiv en direct, provenance et détection de contradictions' },
      memory: { label: 'Architecture Mémoire', shortLabel: 'Mémoire', subtitle: 'Stockage persistant à 7 portées avec déduplication SHA-256' },
      quant: { label: 'Laboratoire Quant', shortLabel: 'Quant', subtitle: 'Validation OHLCV, backtesting, Walk-Forward OOS & Monte Carlo' },
      commerce: { label: 'Intelligence Commerce', shortLabel: 'Commerce', subtitle: 'Analyse d’opportunités, pipeline CRM, devis brouillons et site web' },
      engineering: { label: 'Forge Logicielle', shortLabel: 'Forge', subtitle: 'Espaces de travail isolés, exécuteur de tests et instantanés' },
      analytics: { label: 'Analytique Système', shortLabel: 'Analytique', subtitle: 'Télémétrie de latence, équilibre épistémique et registre SHA-256' },
      security: { label: 'Coffre Sécurité', shortLabel: 'Sécurité', subtitle: 'Authentification PBKDF2, contrôle RBAC, validations et journal d’audit' },
      control: { label: 'Contrôle Système', shortLabel: 'Contrôle', subtitle: 'État de préparation, verrous de sécurité, gouvernance et sauvegardes' },
    },
    coreStates: {
      dormant: { label: 'Équilibre Dormant', shortLabel: 'Dormant', detail: 'Veille orbitale basse énergie' },
      aware: { label: 'Réception Active', shortLabel: 'Éveillé', detail: 'Analyseur d’objectifs prêt' },
      listening: { label: 'Capture Acoustique', shortLabel: 'Écoute', detail: 'Flux microphone actif' },
      reasoning: { label: 'Raisonnement Profond', shortLabel: 'Analyse', detail: 'Synthèse logique multi-étapes' },
      collaborating: { label: 'Conseil Synchronisé', shortLabel: 'Conseil', detail: '15 agents en coordination structurée' },
      executing: { label: 'Exécution par Vagues', shortLabel: 'Exécution', detail: 'Pipeline noyau en calcul parallèle' },
      speaking: { label: 'Synthèse Vocale', shortLabel: 'Parole', detail: 'Modulation audio active' },
      completed: { label: 'Achèvement Vérifié', shortLabel: 'Validé', detail: 'Résultats scellés et persistés' },
      failed: { label: 'Diagnostic d’Arrêt', shortLabel: 'Défaut', detail: 'Exécution stoppée sur garde-fou' },
    },
    common: {
      sync: 'Synchroniser',
      role: 'Rôle',
      gates: 'Validations',
      freeOnlyLock: 'Repli Payant Verrouillé',
      paperOnlyLock: 'Simulation Papier Uniquement',
      lowPowerMode: 'Observatoire 2D',
      webglMode: 'Spatial 3D',
      launchMission: 'Exécuter Pipeline',
      interpretObjective: 'Analyser Flux',
      openWorkspace: 'Ouvrir Espace',
      inspectCore: 'Inspecter Sculpture',
      restoreHud: 'Afficher Contrôles',
      send: 'Transmettre',
      cancel: 'Annuler',
      refresh: 'Actualiser',
      noData: 'Aucun enregistrement persisté.',
    },
    genesis: {
      kicker: 'Architecture d’Intelligence Éternelle',
      headline: 'Orchestrez la recherche scientifique, le quantitatif et l’ingénierie logicielle dans un seul système.',
      subline: 'Formulez un objectif complexe en français, anglais ou arabe. NEXA détecte les ambiguïtés, planifie les vagues d’agents et scelle des livrables vérifiés.',
      commandPlaceholder: 'Décrivez un objectif : backtest XAUUSD, architecture TypeScript résiliente, comparaison de modèles gratuits...',
      quickPromptsTitle: 'Objectifs Calibrés',
      quickPrompts: [
        { label: 'Audit Volatilité Quant', domain: 'quant', prompt: 'Comparer SMA crossover et RSI mean-reversion sur XAUUSD avec validation Walk-Forward 70/30.' },
        { label: 'Architecture Service TS', domain: 'software', prompt: 'Concevoir une file de tâches TypeScript résiliente avec persistance SQLite et tests automatisés.' },
        { label: 'Synthèse Scientifique', domain: 'research', prompt: 'Rechercher des articles arXiv sur la microstructure de marché et séparer faits vérifiés et hypothèses.' },
        { label: 'Étude Commerciale', domain: 'commerce', prompt: 'Évaluer l’automatisation de prise de rendez-vous cliniques sans inventer de revenus non vérifiés.' },
      ],
    },
  },
};
