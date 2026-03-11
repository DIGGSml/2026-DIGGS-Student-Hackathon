import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import 'core/auth_logic.dart';
import 'core/project_sync_service.dart';
import 'core/saved_projects_logic.dart';
import 'core/settings_logic.dart';
import 'screens/auth_screen.dart';
import 'screens/saved_projects_screen.dart';
import 'screens/setup_screen.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final prefs = await SharedPreferences.getInstance();
  const supabaseUrl = String.fromEnvironment(
    'SUPABASE_URL',
    defaultValue: '',
  );
  const supabaseAnonKey = String.fromEnvironment(
    'SUPABASE_ANON_KEY',
    defaultValue: '',
  );
  const authBypass = bool.fromEnvironment(
    'DISABLE_AUTH',
    defaultValue: false,
  );
  const authRedirectUrl = String.fromEnvironment(
    'AUTH_REDIRECT_URL',
    defaultValue: 'com.saximeter.saximeter://login-callback',
  );
  final supabaseConfigured =
      supabaseUrl.isNotEmpty && supabaseAnonKey.isNotEmpty;

  if (supabaseConfigured) {
    await Supabase.initialize(
      url: supabaseUrl,
      anonKey: supabaseAnonKey,
    );
  }
  await ProjectSyncService.syncPendingUploads();

  runApp(
    ProviderScope(
      overrides: [
        settingsProvider.overrideWith((ref) => SettingsNotifier(prefs)),
        supabaseEnabledProvider.overrideWithValue(supabaseConfigured),
        authBypassProvider.overrideWithValue(authBypass),
        authRedirectUrlProvider.overrideWithValue(authRedirectUrl),
      ],
      child: const SaximeterApp(),
    ),
  );
}

class SaximeterApp extends ConsumerWidget {
  const SaximeterApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final authState = ref.watch(authProvider);
    final authBypass = ref.watch(authBypassProvider);
    const presentationStart =
        String.fromEnvironment('PRESENTATION_START', defaultValue: '');

    Widget home;
    if (authBypass) {
      if (presentationStart == 'projects') {
        home = const SavedProjectsScreen();
      } else if (presentationStart == 'directory') {
        final sampleProject = buildMockSavedProjects(
          userToken: 'demo_user',
          now: DateTime(2026, 3, 9, 10, 30),
        ).first;
        home = ProjectDirectoryScreen(project: sampleProject);
      } else {
        home = const SetupScreen();
      }
    } else {
      switch (authState.status) {
        case AuthStatus.loading:
          home = const _AuthLoadingScreen();
          break;
        case AuthStatus.authenticated:
          home = const SetupScreen();
          break;
        case AuthStatus.unauthenticated:
          home = const AuthScreen();
          break;
        case AuthStatus.disabled:
          home = _SupabaseConfigurationScreen(
            message: authState.errorMessage,
          );
          break;
      }
    }

    return MaterialApp(
      title: 'Pile Stroke Log',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(
          seedColor: Colors.deepPurple,
          brightness: Brightness.light, // Setup screen uses light theme
        ),
        useMaterial3: true,
      ),
      home: home,
    );
  }
}

class _AuthLoadingScreen extends StatelessWidget {
  const _AuthLoadingScreen();

  @override
  Widget build(BuildContext context) {
    return const Scaffold(
      body: Center(
        child: CircularProgressIndicator(),
      ),
    );
  }
}

class _SupabaseConfigurationScreen extends StatelessWidget {
  final String? message;

  const _SupabaseConfigurationScreen({this.message});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFFF5F7FA),
      body: Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 560),
            child: Card(
              child: Padding(
                padding: const EdgeInsets.all(20),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text(
                      'Supabase configuration required',
                      style: TextStyle(
                        fontSize: 20,
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                    const SizedBox(height: 12),
                    Text(
                      message ??
                          'Set SUPABASE_URL and SUPABASE_ANON_KEY to enable login.',
                    ),
                    const SizedBox(height: 12),
                    const SelectableText(
                      'flutter run --dart-define=SUPABASE_URL=<your-url> '
                      '--dart-define=SUPABASE_ANON_KEY=<your-anon-key> '
                      '--dart-define=AUTH_REDIRECT_URL=com.saximeter.saximeter://login-callback',
                      style: TextStyle(fontFamily: 'monospace'),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
