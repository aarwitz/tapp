import UIKit

@main
class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        window = UIWindow(frame: UIScreen.main.bounds)
        let vc = UIViewController()
        vc.view.backgroundColor = .black
        let label = UILabel()
        label.text = "AutoTap Harness"
        label.textColor = .white
        label.textAlignment = .center
        label.frame = vc.view.bounds
        label.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        vc.view.addSubview(label)
        window?.rootViewController = vc
        window?.makeKeyAndVisible()
        return true
    }
}
