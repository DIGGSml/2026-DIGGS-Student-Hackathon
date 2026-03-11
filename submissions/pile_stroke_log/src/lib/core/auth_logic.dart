import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supabase_flutter/supabase_flutter.dart' as supa;

enum AuthStatus {
  loading,
  authenticated,
  unauthenticated,
  disabled,
}

class UserAuthState {
  final AuthStatus status;
  final supa.User? user;
  final String? errorMessage;
  final String? infoMessage;

  const UserAuthState({
    required this.status,
    this.user,
    this.errorMessage,
    this.infoMessage,
  });

  const UserAuthState.loading()
      : status = AuthStatus.loading,
        user = null,
        errorMessage = null,
        infoMessage = null;

  const UserAuthState.disabled()
      : status = AuthStatus.disabled,
        user = null,
        errorMessage = null,
        infoMessage = null;

  UserAuthState copyWith({
    AuthStatus? status,
    supa.User? user,
    String? errorMessage,
    String? infoMessage,
    bool clearUser = false,
    bool clearError = false,
    bool clearInfo = false,
  }) {
    return UserAuthState(
      status: status ?? this.status,
      user: clearUser ? null : (user ?? this.user),
      errorMessage: clearError ? null : (errorMessage ?? this.errorMessage),
      infoMessage: clearInfo ? null : (infoMessage ?? this.infoMessage),
    );
  }
}

final supabaseEnabledProvider = Provider<bool>((ref) => false);
final authBypassProvider = Provider<bool>((ref) => false);
final authRedirectUrlProvider = Provider<String?>((ref) => null);

final authProvider = StateNotifierProvider<AuthNotifier, UserAuthState>((ref) {
  final enabled = ref.watch(supabaseEnabledProvider);
  final redirectUrl = ref.watch(authRedirectUrlProvider);
  return AuthNotifier(
    enabled: enabled,
    emailRedirectTo: redirectUrl,
  );
});

class AuthNotifier extends StateNotifier<UserAuthState> {
  final supa.SupabaseClient? _client;
  final String? _emailRedirectTo;
  StreamSubscription<supa.AuthState>? _authSubscription;

  AuthNotifier({
    required bool enabled,
    String? emailRedirectTo,
  })  : _emailRedirectTo = _normalizeRedirect(emailRedirectTo),
        _client = enabled ? _tryGetClient() : null,
        super(enabled
            ? const UserAuthState.loading()
            : const UserAuthState.disabled()) {
    if (_client == null) {
      state = state.copyWith(
        status: AuthStatus.disabled,
        errorMessage:
            'Supabase is not configured. Set SUPABASE_URL and SUPABASE_ANON_KEY.',
      );
      return;
    }

    _hydrateFromSession();
    _authSubscription =
        _client.auth.onAuthStateChange.listen(_onAuthStateChange);
  }

  static supa.SupabaseClient? _tryGetClient() {
    try {
      return supa.Supabase.instance.client;
    } catch (_) {
      return null;
    }
  }

  static String? _normalizeRedirect(String? value) {
    if (value == null) return null;
    final trimmed = value.trim();
    if (trimmed.isEmpty) return null;
    return trimmed;
  }

  void _hydrateFromSession() {
    final user = _client!.auth.currentUser;
    if (user != null) {
      state = UserAuthState(
        status: AuthStatus.authenticated,
        user: user,
      );
      return;
    }

    state = const UserAuthState(
      status: AuthStatus.unauthenticated,
    );
  }

  void _onAuthStateChange(supa.AuthState authState) {
    final user = authState.session?.user ?? _client!.auth.currentUser;
    if (user != null) {
      state = UserAuthState(
        status: AuthStatus.authenticated,
        user: user,
      );
      return;
    }

    state = const UserAuthState(
      status: AuthStatus.unauthenticated,
    );
  }

  Future<void> signIn({
    required String email,
    required String password,
  }) async {
    if (_client == null) return;

    final normalizedEmail = email.trim();
    state = state.copyWith(
      status: AuthStatus.loading,
      clearError: true,
      clearInfo: true,
    );

    try {
      final response = await _client.auth.signInWithPassword(
        email: normalizedEmail,
        password: password,
      );
      final user = response.user ?? _client.auth.currentUser;
      if (user == null) {
        state = const UserAuthState(
          status: AuthStatus.unauthenticated,
          errorMessage: 'Login did not return a user session.',
        );
        return;
      }

      state = UserAuthState(
        status: AuthStatus.authenticated,
        user: user,
      );
    } on supa.AuthException catch (e) {
      state = UserAuthState(
        status: AuthStatus.unauthenticated,
        errorMessage: e.message,
      );
    } catch (e) {
      state = UserAuthState(
        status: AuthStatus.unauthenticated,
        errorMessage: 'Login failed: $e',
      );
    }
  }

  Future<void> signUp({
    required String email,
    required String password,
  }) async {
    if (_client == null) return;

    final normalizedEmail = email.trim();
    state = state.copyWith(
      status: AuthStatus.loading,
      clearError: true,
      clearInfo: true,
    );

    try {
      final response = await _client.auth.signUp(
        email: normalizedEmail,
        password: password,
        emailRedirectTo: _emailRedirectTo,
      );

      final session = response.session;
      final user = response.user ?? _client.auth.currentUser;

      if (session == null) {
        state = const UserAuthState(
          status: AuthStatus.unauthenticated,
          infoMessage:
              'Account created. Check your email to confirm, then sign in.',
        );
        return;
      }

      if (user == null) {
        state = const UserAuthState(
          status: AuthStatus.unauthenticated,
          errorMessage:
              'Signup completed but no active user session was found.',
        );
        return;
      }

      state = UserAuthState(
        status: AuthStatus.authenticated,
        user: user,
      );
    } on supa.AuthException catch (e) {
      state = UserAuthState(
        status: AuthStatus.unauthenticated,
        errorMessage: e.message,
      );
    } catch (e) {
      state = UserAuthState(
        status: AuthStatus.unauthenticated,
        errorMessage: 'Signup failed: $e',
      );
    }
  }

  Future<void> signOut() async {
    if (_client == null) return;

    state = state.copyWith(
      status: AuthStatus.loading,
      clearError: true,
      clearInfo: true,
    );

    try {
      await _client.auth.signOut();
      state = const UserAuthState(
        status: AuthStatus.unauthenticated,
      );
    } on supa.AuthException catch (e) {
      state = UserAuthState(
        status: AuthStatus.authenticated,
        user: _client.auth.currentUser,
        errorMessage: e.message,
      );
    } catch (e) {
      state = UserAuthState(
        status: AuthStatus.authenticated,
        user: _client.auth.currentUser,
        errorMessage: 'Sign out failed: $e',
      );
    }
  }

  void clearMessages() {
    state = state.copyWith(
      clearError: true,
      clearInfo: true,
    );
  }

  @override
  void dispose() {
    _authSubscription?.cancel();
    super.dispose();
  }
}
