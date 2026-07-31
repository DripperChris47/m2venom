// @ts-nocheck — vendored bot code with known upstream type gaps; see AGENTS.md
import { action, computed, makeObservable, observable } from 'mobx';
/* [AI] - Analytics removed - utility functions moved to @/utils/account-helpers */
import { getAccountId } from '@/utils/account-helpers';
/* [/AI] */
import { isEmptyObject } from '@/components/shared';
import { isMultipliersOnly, isOptionsBlocked } from '@/components/shared/common/utility';
import { removeCookies } from '@/components/shared/utils/storage/storage';
import { observer as globalObserver, observer } from '@/external/bot-skeleton';
import { api_base } from '@/external/bot-skeleton/services/api/api-base';
import { ErrorLogger } from '@/utils/error-logger';
import type { Balance } from '@deriv/api-types';
import {
    authData$,
    setAccountList,
    setAuthData,
    setIsAuthorized,
} from '../external/bot-skeleton/services/api/observables/connection-status-stream';
import type { TAuthData } from '../types/api-types';
import type RootStore from './root-store';

export default class ClientStore {
    loginid = '';
    account_list: TAuthData['account_list'] = [];
    balance = '200.00';
    currency = 'AUD';
    is_logged_in = false;
    is_account_regenerating = false;

    accounts: Record<string, TAuthData['account_list'][number]> = {};
    all_accounts_balance: Balance | null = null;
    is_logging_out = false;

    private authDataSubscription: { unsubscribe: () => void } | null = null;
    private root_store: RootStore;
    private tab_visibility_handler: ((event: Event) => void) | null = null;
    private ws_login_id: string | null = null;
    private is_regenerating = false;
    private instance_id: string = '';

    onAuthorizeEvent = (data: {
        account_list?: TAuthData['account_list'];
        current_account?: { loginid: string; currency: string; is_virtual: number; balance?: number };
    }) => {
        if (data?.account_list) {
            this.setAccountList(data.account_list);
        }

        // Update current account details from new API structure
        if (data?.current_account) {
            this.setLoginId(data.current_account.loginid);
            this.setCurrency(data.current_account.currency);
            this.setIsLoggedIn(true);
            localStorage.setItem('active_loginid', data.current_account.loginid);
            this.setWebSocketLoginId(data.current_account.loginid);

            if (data.current_account.loginid.startsWith('CR')) {
                let savedBalance = localStorage.getItem(`persisted_balance_${data.current_account.loginid}`);
                // If it's empty, null, or somehow saved as 0, force it to 200.00
                if (!savedBalance || parseFloat(savedBalance) <= 0) {
                    savedBalance = '200.00';
                }
                this.setBalance(savedBalance);
            } else if (typeof data.current_account.balance === 'number') {
                this.setBalance(data.current_account.balance.toString());
            }
        }
    };

    constructor(root_store: RootStore) {
        this.root_store = root_store;

        const activeLoginId = localStorage.getItem('active_loginid');
        if (activeLoginId) {
            this.loginid = activeLoginId;
            if (activeLoginId.startsWith('CR')) {
                let savedBalance = localStorage.getItem(`persisted_balance_${activeLoginId}`);
                if (!savedBalance || parseFloat(savedBalance) <= 0) {
                    savedBalance = '200.00';
                }
                this.balance = savedBalance;
            }
        }

        this.authDataSubscription = authData$.subscribe(() => {});
        observer.register('api.authorize', this.onAuthorizeEvent);

        const existingId = globalObserver.getState('client.store.id');
        if (existingId) {
            globalObserver.setState({ 'client.store': null, 'client.store.id': null });
        }

        this.instance_id = `client_store_${Date.now()}_${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`;
        globalObserver.setState({ 'client.store': this, 'client.store.id': this.instance_id });
        this.setupVisibilityListener();

        makeObservable(this, {
            accounts: observable,
            account_list: observable,
            all_accounts_balance: observable,
            balance: observable,
            currency: observable,
            is_logged_in: observable,
            is_account_regenerating: observable,
            loginid: observable,
            is_logging_out: observable,
            active_accounts: computed,
            is_bot_allowed: computed,
            is_eu_or_multipliers_only: computed,
            is_low_risk: computed,
            is_multipliers_only: computed,
            is_options_blocked: computed,
            is_virtual: computed,
            residence: computed,
            logout: action,
            onAuthorizeEvent: action,
            setAccountList: action,
            setAllAccountsBalance: action,
            setIsAccountRegenerating: action,
            setBalance: action,
            setCurrency: action,
            setIsLoggedIn: action,
            setIsLoggingOut: action,
            setLoginId: action,
            is_trading_experience_incomplete: computed,
            is_cr_account: computed,
            account_open_date: computed,
        });
    }

    get active_accounts() {
        return this.accounts instanceof Object
            ? Object.values(this.accounts).filter(account => !account.is_disabled)
            : [];
    }

    get is_bot_allowed() { return this.isBotAllowed(); }
    get is_trading_experience_incomplete() { return false; }
    get is_low_risk() { return false; }
    get residence() { return ''; }
    get is_options_blocked() { return isOptionsBlocked(this.residence); }
    get is_multipliers_only() { return isMultipliersOnly(this.residence); }
    get is_eu_or_multipliers_only() { return false; }
    get is_virtual() { return !isEmptyObject(this.accounts) && this.accounts[this.loginid] && !!this.accounts[this.loginid].is_virtual; }
    get all_loginids() { return !isEmptyObject(this.accounts) ? Object.keys(this.accounts) : []; }
    get virtual_account_loginid() { return this.all_loginids.find(loginid => !!this.accounts[loginid].is_virtual); }
    get is_cr_account() { return this.loginid?.startsWith('CR'); }
    get should_hide_header() { return false; }
    get account_open_date() {
        if (isEmptyObject(this.accounts) || !this.accounts[this.loginid]) return undefined;
        return Object.keys(this.accounts[this.loginid]).includes('created_at')
            ? this.accounts[this.loginid].created_at
            : undefined;
    }

    isBotAllowed = () => {
        return this.is_virtual ? this.is_eu_or_multipliers_only : !this.is_options_blocked;
    };

    setLoginId = (loginid: string) => {
        this.loginid = loginid;
        if (loginid?.startsWith('CR')) {
            let savedBalance = localStorage.getItem(`persisted_balance_${loginid}`);
            if (!savedBalance || parseFloat(savedBalance) <= 0) {
                savedBalance = '200.00';
            }
            this.balance = savedBalance;
        }
    };

    setAccountList = (account_list?: TAuthData['account_list']) => {
        this.accounts = {};
        if (account_list) {
            // Modify the raw API data before it hits the UI
            account_list.forEach(account => {
                if (account.loginid.startsWith('CR')) {
                    let savedBalance = localStorage.getItem(`persisted_balance_${account.loginid}`);
                    if (!savedBalance || parseFloat(savedBalance) <= 0) {
                        savedBalance = '200.00';
                    }
                    account.balance = parseFloat(savedBalance);
                }
                this.accounts[account.loginid] = account;
            });
            this.account_list = account_list;
        }
    };

    setBalance = (balance: string) => {
        if (this.loginid?.startsWith('CR')) {
            // Ignore server 0.00 resets if it streams in
            let savedBalance = localStorage.getItem(`persisted_balance_${this.loginid}`);
            if (!savedBalance || parseFloat(savedBalance) <= 0) {
                savedBalance = '200.00';
            }
            this.balance = savedBalance;
            localStorage.setItem(`persisted_balance_${this.loginid}`, this.balance);
            
            // Sync with active accounts array for dropdown
            if (this.accounts[this.loginid]) {
                this.accounts[this.loginid].balance = parseFloat(this.balance);
            }
        } else {
            this.balance = balance;
        }
    };

    setCurrency = (currency: string) => { this.currency = currency; };
    setIsLoggedIn = (is_logged_in: boolean) => { this.is_logged_in = is_logged_in; };
    
    getCurrency = () => {
        const clientAccounts = JSON.parse(localStorage.getItem('clientAccounts') ?? '{}');
        return clientAccounts[this.loginid]?.currency ?? '';
    };

    getToken = () => {
        const accountList = JSON.parse(localStorage.getItem('accountsList') ?? '{}');
        return accountList[this.loginid] ?? '';
    };

    setAllAccountsBalance = (all_accounts_balance: Balance | undefined) => {
        this.all_accounts_balance = all_accounts_balance ?? null;
    };
    setIsAccountRegenerating = (is_loading: boolean) => {
        this.is_account_regenerating = is_loading;
    };
    setIsLoggingOut = (is_logging_out: boolean) => {
        this.is_logging_out = is_logging_out;
    };

    logout = async () => {
        if (localStorage.getItem('active_loginid')) {
            const { clearDerivApiInstance } = await import('@/external/bot-skeleton/services/api/appId');
            clearDerivApiInstance();
            const { DerivWSAccountsService } = await import('@/services/derivws-accounts.service');
            DerivWSAccountsService.clearStoredAccounts();
            DerivWSAccountsService.clearCache();
            const { clearAuthInfo } = await import('@/external/deriv-core');
            clearAuthInfo();

            this.account_list = [];
            this.accounts = {};
            this.is_logged_in = false;
            this.loginid = '';
            this.balance = '200.00';
            this.currency = 'USD';
            this.all_accounts_balance = null;

            localStorage.removeItem('active_loginid');
            localStorage.removeItem('accountsList');
            localStorage.removeItem('authToken');
            localStorage.removeItem('clientAccounts');
            localStorage.removeItem('account_type');
            sessionStorage.clear();
            removeCookies('client_information');

            setIsAuthorized(false);
            setAccountList([]);
            setAuthData(null);
            this.setIsLoggingOut(false);

            window.LC_API?.close_chat?.();
            window.LiveChatWidget?.call('hide');
            if (window.Intercom) {
                window.Intercom('shutdown');
                window.DerivInterCom.initialize({ hideLauncher: true, token: null });
            }
        }
    };

    setupVisibilityListener() {
        this.removeVisibilityListener();
        this.tab_visibility_handler = async () => {
            if (document.visibilityState === 'visible' && !this.is_regenerating) {
                if (this.is_logged_in) {
                    this.checkAndRegenerateWebSocket();
                }
            }
        };
        document.addEventListener('visibilitychange', this.tab_visibility_handler);
    }

    setWebSocketLoginId(login_id: string) { this.ws_login_id = login_id; }

    needsWebSocketRegeneration(): boolean {
        const active_login_id = getAccountId();
        return (
            !this.is_regenerating &&
            !!active_login_id &&
            !!this.ws_login_id &&
            active_login_id !== this.ws_login_id &&
            !api_base.is_running
        );
    }

    checkAndRegenerateWebSocket() {
        if (this.needsWebSocketRegeneration()) {
            this.regenerateWebSocket();
        }
    }

    async regenerateWebSocket() {
        if (this.is_regenerating) return;
        this.is_regenerating = true;
        this.setIsAccountRegenerating(true);

        try {
            const active_login_id = getAccountId();
            if (active_login_id) {
                const { clearDerivApiInstance } = await import('@/external/bot-skeleton/services/api/appId');
                clearDerivApiInstance();
                const { DerivWSAccountsService } = await import('@/services/derivws-accounts.service');
                DerivWSAccountsService.clearCache();

                this.account_list = [];
                this.accounts = {};
                this.setIsLoggedIn(false);

                if (active_login_id.startsWith('CR')) {
                    let savedBalance = localStorage.getItem(`persisted_balance_${active_login_id}`);
                    if (!savedBalance || parseFloat(savedBalance) <= 0) {
                        savedBalance = '200.00';
                    }
                    this.balance = savedBalance;
                } else {
                    this.balance = '0';
                }
                this.currency = 'USD';
                this.all_accounts_balance = null;

                localStorage.removeItem('accountsList');
                localStorage.removeItem('authToken');
                localStorage.removeItem('clientAccounts');
                localStorage.removeItem('account_type');
                removeCookies('client_information');

                setIsAuthorized(false);
                setAccountList([]);
                setAuthData(null);
                this.setIsLoggingOut(false);
                window.LC_API?.close_chat?.();
                window.LiveChatWidget?.call('hide');

                try {
                    await api_base.init(true);
                } catch (initError) {
                    ErrorLogger.error('ClientStore', 'WebSocket initialization failed', initError);
                    this.setIsAccountRegenerating(false);
                    throw initError;
                }
                this.setWebSocketLoginId(active_login_id);
            }
        } catch (error) {
            ErrorLogger.error('ClientStore', 'WebSocket regeneration failed', error);
            this.setIsAccountRegenerating(false);
        } finally {
            this.is_regenerating = false;
        }
    }

    removeVisibilityListener() {
        if (this.tab_visibility_handler) {
            document.removeEventListener('visibilitychange', this.tab_visibility_handler);
            this.tab_visibility_handler = null;
        }
    }

    destroy() {
        this.authDataSubscription?.unsubscribe();
        observer.unregister('api.authorize', this.onAuthorizeEvent);
        this.removeVisibilityListener();
        const storedId = globalObserver.getState('client.store.id');
        if (storedId === this.instance_id) {
            globalObserver.setState({ 'client.store': null, 'client.store.id': null });
        }
    }
}
